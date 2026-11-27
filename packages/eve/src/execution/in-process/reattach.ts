import { summarizeTurnEvents } from "#client/session-utils.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import {
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
  type TaskCall,
  type TaskRunAddress,
} from "#execution/tasks/table.js";
import { taskRunHookToken } from "#execution/tools/workflow/start.js";
import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { isSubagentAdapterState } from "#subagents/adapter-state.js";
import { createUlid } from "#shared/ulid.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcome,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { toWorkflowOutput } from "#execution/tools/workflow/body.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { RunHook } from "#execution/run-host.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

export interface ChildLink {
  readonly sessionId: string;
  readonly deliveryId: string | undefined;
  readonly callId: string;
}

export interface OpenAgentTask {
  readonly parentSessionId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly run: TaskRunAddress;
  readonly calls: readonly TaskCall[];
  readonly child: ChildLink | undefined;
}

export interface ReattachHost {
  readEvents(sessionId: string): Promise<ReadableStream<SessionStreamEvent>>;
  cancelChildTurn(sessionId: string): Promise<void>;
}

export function openAgentTasks(input: {
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly lines: readonly string[];
}): OpenAgentTask[] {
  const table = readTaskTable(readDurableSession(input.sessionState).state);
  const facts = recordedFacts(input.lines);
  const open = table.tasks.flatMap((record) => {
    if (record.kind !== "agent" || record.cancelled === true) return [];
    if (facts.endedTasks.has(record.id)) return [];
    const calls = record.calls.filter((call) => !facts.settledCalls.has(call.callId));
    return calls.length === 0 ? [] : [{ ...record, calls }];
  });
  if (open.length === 0) return [];
  const links = facts.links;
  return open.map((record) => ({
    calls: record.calls,
    child: record.calls
      .map((call) => links.get(call.callId))
      .filter((link) => link !== undefined)
      .at(-1),
    parentSessionId: input.sessionId,
    run: { hookToken: taskRunHookToken(input.sessionId, record.id), runId: recoveryRunId() },
    taskId: record.id,
    toolName: record.name,
  }));
}

export function adoptAgentTasks(
  sessionState: DurableSessionState,
  tasks: readonly OpenAgentTask[],
): DurableSessionState {
  if (tasks.length === 0) return sessionState;
  const session = readDurableSession(sessionState);
  let table = readTaskTable(session.state);
  for (const task of tasks) table = recordTaskRun(table, task.taskId, task.run);
  return replaceDurableSessionSnapshot({
    session: writeTaskTable(session, table),
    state: sessionState,
  });
}

export function linkFromChild(
  task: OpenAgentTask,
  child: { readonly sessionId: string; readonly serializedContext: Record<string, unknown> },
): ChildLink | undefined {
  const adapter = child.serializedContext[CHANNEL_CONTEXT_KEY_NAME] as
    | { readonly state?: unknown }
    | undefined;
  const state = adapter?.state;
  if (!isSubagentAdapterState(state)) return undefined;
  if (state.parentSessionId !== task.parentSessionId) return undefined;
  if (!task.calls.some((call) => call.callId === state.callId)) return undefined;
  return { callId: state.callId, deliveryId: undefined, sessionId: child.sessionId };
}

function recoveryRunId(): string {
  return `wrun_in_process_${createUlid()}`;
}

export function settledByFacts(
  sessionState: DurableSessionState,
  lines: readonly string[],
): DurableSessionState {
  const facts = recordedFacts(lines);
  const session = readDurableSession(sessionState);
  const table = readTaskTable(session.state);
  let changed = false;
  const tasks = table.tasks.map((record) => {
    const calls = facts.endedTasks.has(record.id)
      ? []
      : record.calls.filter((call) => !facts.settledCalls.has(call.callId));
    if (calls.length === record.calls.length) return record;
    changed = true;
    return { ...record, calls };
  });
  if (!changed) return sessionState;
  return replaceDurableSessionSnapshot({
    session: writeTaskTable(session, { tasks }),
    state: sessionState,
  });
}

function recordedFacts(lines: readonly string[]) {
  const settledCalls = new Set<string>();
  const endedTasks = new Set<string>();
  for (const fact of factsOf(lines)) {
    const data = fact.data as { callId?: unknown; taskId?: unknown };
    if (fact.type === "call.settled" && typeof data.callId === "string")
      settledCalls.add(data.callId);
    if (fact.type === "task.ended" && typeof data.taskId === "string") endedTasks.add(data.taskId);
  }
  return { endedTasks, links: childLinks(lines), settledCalls };
}

function factsOf(lines: readonly string[]): { readonly type?: unknown; readonly data?: unknown }[] {
  return lines.flatMap((line) => {
    try {
      const facts = (JSON.parse(line) as { readonly facts?: unknown }).facts;
      return Array.isArray(facts) ? (facts as { type?: unknown; data?: unknown }[]) : [];
    } catch {
      return [];
    }
  });
}

function childLinks(lines: readonly string[]): Map<string, ChildLink> {
  const links = new Map<string, ChildLink>();
  {
    for (const fact of factsOf(lines)) {
      if (fact.type !== "child.sent") continue;
      const data = fact.data as Partial<{
        sessionId: string;
        childDeliveryId: string;
        callId: string;
      }>;
      if (
        typeof data.sessionId !== "string" ||
        typeof data.childDeliveryId !== "string" ||
        typeof data.callId !== "string"
      )
        continue;
      links.set(data.callId, {
        callId: data.callId,
        deliveryId: data.childDeliveryId,
        sessionId: data.sessionId,
      });
    }
  }
  return links;
}

export async function reattachAgentTask(
  task: OpenAgentTask,
  hook: RunHook<WorkflowToolRunControlMessage>,
  host: ReattachHost,
): Promise<void> {
  const send = (message: WorkflowToolRunMessage, ifPresent = false) =>
    resumeRoutedHook(
      sessionInboxHookToken(sessionCommandHookToken(task.parentSessionId)),
      message,
    ).catch((error: unknown) => {
      if (!ifPresent) throw error;
    });
  const from = runRef(task);
  const finish = (result: WorkflowToolRunOutcome) => send({ from, kind: "outcome", result });
  await send({ from, kind: "started" });

  if (task.child === undefined) {
    await finish({
      error: normalizeSerializableError(
        new Error(
          `eve restarted while the ${task.toolName} task was starting, and its parent session records no message sent to the agent for call ${task.calls.at(-1)!.callId}. eve could not confirm whether the agent received it. This task has ended; to retry, call ${task.toolName} without taskId.`,
        ),
      ),
      status: "failed",
    });
    return;
  }
  const child = task.child;
  const followUps: string[] = [];
  const stop = new AbortController();
  const commands = (async () => {
    for await (const command of hook) {
      if (command.kind === "call") {
        followUps.push(command.call.callId);
        continue;
      }
      if (command.kind === "end" || command.kind === "cancel") {
        stop.abort(command.reason);
        return;
      }
    }
  })();

  const settled = await settledChildTurn(child, host, stop.signal);
  if (settled === undefined) {
    await host.cancelChildTurn(child.sessionId).catch(() => {});
    await finish({ reason: String(stop.signal.reason ?? ""), status: "cancelled" });
    await commands;
    return;
  }
  if (settled.status !== "completed") {
    const reason =
      settled.status === "cancelled"
        ? "The agent invocation was cancelled."
        : (settled.failure?.message ?? "The agent's turn failed.");
    await finish({
      error: normalizeSerializableError(
        new Error(
          `The agent's turn failed: ${reason}\nThis task has ended; to retry, call ${task.toolName} without taskId.`,
        ),
      ),
      status: "failed",
    });
    return;
  }
  const output = toWorkflowOutput(
    { callId: child.callId, toolName: task.toolName },
    settled.message ?? "",
  );
  const replied = task.calls.map((call) => call.callId);
  await send({ callIds: replied, from, kind: "reply", output });
  await finish(
    followUps.length === 0
      ? { output, status: "completed" }
      : {
          error: normalizeSerializableError(
            new Error(
              `eve restarted while the ${task.toolName} task worked, so it ended after its reply. To continue, call ${task.toolName} without taskId.`,
            ),
          ),
          status: "failed",
        },
  );
}

async function settledChildTurn(
  child: ChildLink,
  host: ReattachHost,
  signal: AbortSignal,
): Promise<ReturnType<typeof summarizeTurnEvents> | undefined> {
  const events: SessionStreamEvent[] = [];
  const reader = (await host.readEvents(child.sessionId)).getReader();
  const abandon = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abandon, { once: true });
  let deliveryId = child.deliveryId;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      events.push(next.value);
      if (child.deliveryId === undefined && next.value.type === "delivery.admitted") {
        deliveryId = next.value.data.deliveryId;
      }
      if (deliveryId === undefined) continue;
      const summary = summarizeTurnEvents(events, deliveryId);
      if (summary.status !== "working" && summary.status !== "awaiting-input") return summary;
    }
    if (signal.aborted) return undefined;
    const summary = summarizeTurnEvents(events, deliveryId);
    return summary.status === "working" || summary.status === "awaiting-input"
      ? {
          ...summary,
          failure: {
            code: "CHILD_ENDED",
            message: "The agent's session ended before its turn settled.",
          },
          status: "failed",
        }
      : summary;
  } finally {
    signal.removeEventListener("abort", abandon);
    await reader.cancel().catch(() => {});
  }
}

function runRef(task: OpenAgentTask): WorkflowToolRunRef {
  const first = task.calls[0]!;
  return {
    callId: task.child?.callId ?? first.callId,
    input: {},
    runId: task.run.runId,
    sequence: 0,
    stepIndex: 0,
    taskId: task.taskId,
    toolName: task.toolName,
    turnId: first.turnId,
  };
}

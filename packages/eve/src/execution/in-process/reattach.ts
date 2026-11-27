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
  type TaskResult,
  type TaskRunAddress,
} from "#execution/tasks/table.js";
import type { JsonValue } from "#shared/json.js";
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
import type { StoredLaunch } from "./session-store.js";

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

export interface StoredChild {
  readonly sessionId: string;
  readonly serializedContext: Record<string, unknown>;
}

export interface AgentTaskRecovery {
  readonly reattach: readonly OpenAgentTask[];
  readonly relaunch: readonly StoredLaunch[];
  readonly unknown: readonly OpenAgentTask[];
}

export function recoverAgentTasks(input: {
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly lines: readonly string[];
  readonly children: readonly StoredChild[];
  readonly launches: readonly StoredLaunch[];
  readonly undispatched: ReadonlySet<string>;
}): AgentTaskRecovery {
  const table = readTaskTable(readDurableSession(input.sessionState).state);
  const facts = recordedFacts(input.lines);
  const reattach: OpenAgentTask[] = [];
  const relaunch: StoredLaunch[] = [];
  const unknown: OpenAgentTask[] = [];
  for (const record of table.tasks) {
    if (record.cancelled === true || (record.kind !== "agent" && record.run === undefined))
      continue;
    if (facts.endedTasks.has(record.id)) continue;
    const calls = record.calls.filter((call) => !facts.settledCalls.has(call.callId));
    if (calls.length === 0) continue;
    if (calls.some((call) => input.undispatched.has(call.callId))) continue;
    const task: OpenAgentTask = {
      calls,
      child: undefined,
      parentSessionId: input.sessionId,
      run: { hookToken: taskRunHookToken(input.sessionId, record.id), runId: recoveryRunId() },
      taskId: record.id,
      toolName: record.name,
    };
    if (record.kind !== "agent") {
      unknown.push(task);
      continue;
    }
    const child =
      calls
        .map((call) => facts.links.get(call.callId))
        .filter((link) => link !== undefined)
        .at(-1) ??
      input.children
        .map((stored) => linkFromChild(task, stored))
        .find((link) => link !== undefined);
    const launch = input.launches.find(
      ({ runId, taskId }) => taskId === record.id && runId === record.run?.runId,
    );
    const evidenced =
      launch?.child !== undefined || calls.some((call) => facts.childCalls.has(call.callId));
    if (child === undefined && launch !== undefined && !evidenced) relaunch.push(launch);
    else reattach.push({ ...task, child });
  }
  return { reattach, relaunch, unknown };
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

export function linkFromChild(task: OpenAgentTask, child: StoredChild): ChildLink | undefined {
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
    const settled = record.calls.filter((call) => facts.settledCalls.has(call.callId));
    const calls = facts.endedTasks.has(record.id)
      ? []
      : record.calls.filter((call) => !facts.settledCalls.has(call.callId));
    if (calls.length === record.calls.length) return record;
    changed = true;
    return { ...record, calls, results: [...record.results, ...resultsOf(settled, facts)] };
  });
  if (!changed) return sessionState;
  return replaceDurableSessionSnapshot({
    session: writeTaskTable(session, { tasks }),
    state: sessionState,
  });
}

function resultsOf(
  calls: readonly TaskCall[],
  facts: ReturnType<typeof recordedFacts>,
): TaskResult[] {
  const results: TaskResult[] = [];
  for (const call of calls) {
    const fact = facts.settledCalls.get(call.callId)!;
    const source = fact.outputOf === undefined ? fact : facts.settledCalls.get(fact.outputOf);
    if (fact.outcome === "completed") {
      results.push({ calls: [call], output: source?.output ?? null, status: "completed" });
    } else if (fact.outcome === "failed") {
      results.push({ calls: [call], error: fact.error ?? "The task failed.", status: "failed" });
    }
  }
  return results;
}

interface SettledCall {
  readonly outcome?: string;
  readonly output?: JsonValue;
  readonly outputOf?: string;
  readonly error?: string;
}

function recordedFacts(lines: readonly string[]) {
  const settledCalls = new Map<string, SettledCall>();
  const endedTasks = new Set<string>();
  const childCalls = new Set<string>();
  for (const fact of factsOf(lines)) {
    const data = fact.data as {
      callId?: unknown;
      taskId?: unknown;
      owner?: { callId?: unknown };
      outcome?: unknown;
      output?: JsonValue;
      outputOf?: { callId?: unknown };
      error?: { message?: unknown };
    };
    if (fact.type === "call.settled" && typeof data.callId === "string") {
      settledCalls.set(data.callId, {
        error: typeof data.error?.message === "string" ? data.error.message : undefined,
        outcome: typeof data.outcome === "string" ? data.outcome : undefined,
        output: data.output,
        outputOf: typeof data.outputOf?.callId === "string" ? data.outputOf.callId : undefined,
      });
    }
    if (fact.type === "task.ended" && typeof data.taskId === "string") endedTasks.add(data.taskId);
    if (fact.type === "child.opened" && typeof data.owner?.callId === "string")
      childCalls.add(data.owner.callId);
    if (fact.type === "child.sent" && typeof data.callId === "string") childCalls.add(data.callId);
  }
  return { childCalls, endedTasks, links: childLinks(lines), settledCalls };
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

export async function endUnknownTask(task: OpenAgentTask): Promise<void> {
  const send = (message: WorkflowToolRunMessage) =>
    resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(task.parentSessionId)), message);
  const from = runRef(task);
  await send({ from, kind: "started" });
  await send({
    from,
    kind: "outcome",
    result: {
      error: normalizeSerializableError(
        new Error(
          `eve restarted while the ${task.toolName} task ran, so its outcome is unknown. eve did not run it again; check its effects before you call ${task.toolName} again.`,
        ),
      ),
      status: "failed",
    },
  });
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

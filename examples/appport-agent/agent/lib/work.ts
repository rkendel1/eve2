import { createHash } from "node:crypto";

import type { AuthResult } from "eve/channels/auth";
import {
  createFeltDB,
  openAgentState,
  type AgentCheckpoint,
  type AgentCheckpointInput,
  type AgentStateStore,
  type AgentTask,
} from "@feltdb/core";

export const AGENT_ID = "agent:appport-agent";
export const APPLICATION_SCOPE = "inventory";
export const INVOCATIONS = "appport_invocations";
export const SUBMISSIONS = "work_submissions";
export const SESSIONS = "work_sessions";
const MAX_HISTORY = 50;
const OPEN_ATTEMPTS = 50;
const OPEN_RETRY_MS = 200;
const WRITE_ATTEMPTS = 3;

type Database = ReturnType<typeof createFeltDB>;
let opened: Promise<{ db: Database; state: AgentStateStore }> | undefined;

async function openStore() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const db = createFeltDB({
        namespace: "appport-agent-work",
        path: process.env.APPPORT_AGENT_WORK_DIR ?? ".appport-agent-work",
      });
      return { db, state: await openAgentState(db) };
    } catch (error) {
      const locked = (error as { code?: unknown }).code === "STATE_LOCKED";
      if (!locked || attempt === OPEN_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    }
  }
}

export function workStore() {
  opened ??= openStore().catch((error: unknown) => {
    opened = undefined;
    throw error;
  });
  return opened;
}

export async function bindSession(sessionId: string, workId: string): Promise<void> {
  const { db } = await workStore();
  const sessions = db.collection<{ work_id: string }>(SESSIONS);
  const existing = await sessions.get(sessionId);
  if (existing !== null) {
    if (existing.work_id !== workId)
      throw new Error(`Session ${sessionId} already belongs to ${existing.work_id}.`);
    return;
  }
  await sessions.insert({ work_id: workId }, sessionId, { requireAbsent: true });
}

export async function workForSession(sessionId: string): Promise<string | null> {
  const { db } = await workStore();
  return (await db.collection<{ work_id: string }>(SESSIONS).get(sessionId))?.work_id ?? null;
}

export function workIdFor(requester: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${requester}\n${idempotencyKey}`).digest("hex");
  return `work_${digest.slice(0, 32)}`;
}

export interface SubmissionRecord {
  readonly accepted_at: string;
  readonly auth: AuthResult;
  readonly objective: string;
  readonly requester: string;
  readonly work_id: string;
}

export async function readSubmission(workId: string): Promise<SubmissionRecord | null> {
  const { db } = await workStore();
  return await db.collection<SubmissionRecord>(SUBMISSIONS).get(workId);
}

export type Acceptance =
  | { readonly outcome: "accepted" | "replayed"; readonly workId: string }
  | { readonly outcome: "conflict"; readonly workId: string };

export async function acceptWork(
  auth: AuthResult & { readonly principalId: string },
  idempotencyKey: string,
  objective: string,
): Promise<Acceptance> {
  const { db, state } = await workStore();
  const requester = auth.principalId;
  const workId = workIdFor(requester, idempotencyKey);
  let submission = await readSubmission(workId);
  if (submission === null) {
    try {
      await db.collection(SUBMISSIONS).insert(
        {
          accepted_at: new Date().toISOString(),
          auth,
          objective,
          requester,
          work_id: workId,
        },
        workId,
        { requireAbsent: true },
      );
    } catch (error) {
      if ((await readSubmission(workId)) === null) throw error;
    }
    submission = await readSubmission(workId);
  }
  if (submission?.objective !== objective) return { outcome: "conflict", workId };
  if ((await state.getTask(workId)) !== null) return { outcome: "replayed", workId };
  try {
    await state.createTask({
      actor: AGENT_ID,
      objective,
      scope: { project: APPLICATION_SCOPE, workspace: requester },
      status: "ready",
      summary: `Accepted from ${requester}.`,
      taskId: workId,
    });
    return { outcome: "accepted", workId };
  } catch (error) {
    if ((await state.getTask(workId)) === null) throw error;
    return { outcome: "replayed", workId };
  }
}

async function history(state: AgentStateStore, task: AgentTask): Promise<AgentCheckpoint[]> {
  const entries: AgentCheckpoint[] = [];
  const first = Math.max(1, task.checkpoint_version - MAX_HISTORY + 1);
  for (let version = first; version <= task.checkpoint_version; version += 1) {
    const checkpoint = await state.getCheckpoint(task.task_id, version);
    if (checkpoint !== null) entries.push(checkpoint);
  }
  return entries;
}

export async function recordedSession(workId: string): Promise<string | null> {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null) return null;
  const entries = await history(state, current.task);
  return (
    [...entries].reverse().find((entry) => entry.execution?.conversation_id)?.execution
      ?.conversation_id ?? null
  );
}

export async function readWork(requester: string, workId: string) {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null || current.task.scope.workspace !== requester) return null;
  const entries = await history(state, current.task);
  const invocations = [];
  for (const entry of current.checkpoint.evidence) {
    if (entry.kind !== "record" || entry.collection !== INVOCATIONS) continue;
    const record = await readCited(entry.id);
    invocations.push({
      callId: record?.call_id ?? null,
      capability: record?.capability ?? null,
      errorCode: record?.error_code ?? null,
      ok: record?.ok === true,
      requestId: record?.request_id ?? null,
    });
  }
  return {
    agent: current.task.owner,
    createdAt: current.task.created_at,
    decisions: current.checkpoint.decisions,
    evidence: current.checkpoint.evidence,
    history: entries.map((entry) => ({
      at: entry.created_at,
      decisions: entry.decisions,
      status: entry.status,
      summary: entry.summary,
      version: entry.version,
    })),
    invocations,
    objective: current.task.objective,
    requester: current.task.scope.workspace,
    scope: current.task.scope,
    sessionId:
      [...entries].reverse().find((entry) => entry.execution?.conversation_id)?.execution
        ?.conversation_id ?? null,
    status: current.task.status,
    summary: current.checkpoint.summary,
    updatedAt: current.task.updated_at,
    workId,
  };
}

export type ProgressInput = Omit<AgentCheckpointInput, "actor" | "expectedVersion">;

export async function recordProgress(
  workId: string,
  build: (current: { task: AgentTask; checkpoint: AgentCheckpoint }) => ProgressInput | null,
): Promise<boolean> {
  const { state } = await workStore();
  for (let attempt = 1; ; attempt += 1) {
    const current = await state.getTask(workId);
    if (current === null) return false;
    if (current.task.status === "completed" || current.task.status === "cancelled") return false;
    const input = build(current);
    if (input === null) return false;
    try {
      await state.checkpoint(workId, {
        ...input,
        actor: AGENT_ID,
        expectedVersion: current.task.checkpoint_version,
      });
      return true;
    } catch (error) {
      const conflict = (error as { code?: unknown }).code === "VERSION_CONFLICT";
      if (!conflict || attempt === WRITE_ATTEMPTS) throw error;
    }
  }
}

export async function unfinishedWork(): Promise<AgentTask[]> {
  const { state } = await workStore();
  const found: AgentTask[] = [];
  for (const status of ["ready", "running", "blocked"] as const) {
    let cursor: string | undefined;
    do {
      const query: Parameters<AgentStateStore["listTasks"]>[0] = {
        limit: 100,
        project: APPLICATION_SCOPE,
        status,
      };
      if (cursor !== undefined) query.cursor = cursor;
      const page = await state.listTasks(query);
      found.push(...page.tasks.filter((task) => task.owner === AGENT_ID));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return found;
}

export interface InvocationEvidence {
  readonly agent: string;
  readonly callId: string;
  readonly capability: string;
  readonly caller: string;
  readonly errorCode: string | null;
  readonly ok: boolean;
  readonly outputDigest: string | null;
  readonly requestId: string;
  readonly workId: string;
}

const CITABLE_ID = /^[A-Za-z0-9._-]{1,80}$/u;

export function invocationId(workId: string, callId: string): string {
  const call = CITABLE_ID.test(callId)
    ? callId
    : createHash("sha256").update(callId).digest("hex").slice(0, 40);
  return `${workId}.${call}`;
}

export async function recordInvocation(evidence: InvocationEvidence): Promise<void> {
  const { db } = await workStore();
  await db.collection(INVOCATIONS).insert(
    {
      agent: evidence.agent,
      appport_provenance: `appport-provenance:${APPLICATION_SCOPE}/${evidence.requestId}`,
      call_id: evidence.callId,
      capability: evidence.capability,
      caller: evidence.caller,
      error_code: evidence.errorCode,
      ok: evidence.ok,
      output_digest: evidence.outputDigest,
      recorded_at: new Date().toISOString(),
      request_id: evidence.requestId,
      work_id: evidence.workId,
    },
    invocationId(evidence.workId, evidence.callId),
    { requireAbsent: true },
  );
}

export async function readInvocation(workId: string, callId: string) {
  const { db } = await workStore();
  const record = await db
    .collection<Record<string, unknown>>(INVOCATIONS)
    .get(invocationId(workId, callId));
  return record !== null && record.work_id === workId && record.call_id === callId ? record : null;
}

async function readCited(id: string) {
  const { db } = await workStore();
  return await db.collection<Record<string, unknown>>(INVOCATIONS).get(id);
}

export interface ObservedCall {
  readonly callId: string;
  readonly settled: boolean;
}

export interface Outcome {
  readonly decision: string;
  readonly evidence: readonly string[];
  readonly status: "blocked" | "completed";
  readonly summary: string;
}

export async function decideOutcome(
  workId: string,
  turnOutcome: string,
  invokeCalls: readonly ObservedCall[],
  reply: string,
): Promise<Outcome> {
  const said = reply.length > 0 ? ` Agent reply: ${reply.slice(0, 2000)}` : "";
  const recorded = [];
  let missing = 0;
  for (const call of invokeCalls) {
    const record = await readInvocation(workId, call.callId);
    if (record !== null)
      recorded.push({ id: invocationId(workId, call.callId), ok: record.ok === true });
    else if (call.settled) missing += 1;
  }
  const evidence = recorded.map((entry) => entry.id);
  const succeeded = recorded.filter((entry) => entry.ok).length;
  if (turnOutcome !== "completed") {
    const decision = `failed: the eve turn ended ${turnOutcome}`;
    return {
      decision,
      evidence,
      status: "blocked",
      summary: `Failed: the eve turn ended ${turnOutcome}.`,
    };
  }
  if (missing > 0) {
    const decision = `indeterminate: ${missing} AppPort invocation(s) without committed evidence`;
    return {
      decision,
      evidence,
      status: "blocked",
      summary: `Indeterminate: eve recorded ${missing} AppPort invocation(s) whose outcome was never committed; see AppPort provenance for this work's trace id.`,
    };
  }
  if (recorded.length > 0 && succeeded === 0) {
    const decision = "waiting: every AppPort invocation was rejected";
    return {
      decision,
      evidence,
      status: "blocked",
      summary: `Blocked: no capability invocation was authorized.${said}`,
    };
  }
  const decision = `completed after ${succeeded} authorized invocation(s)`;
  return {
    decision,
    evidence,
    status: "completed",
    summary: `Completed after ${succeeded} authorized invocation(s).${said}`,
  };
}

export function citeNew(current: AgentCheckpoint, callIds: readonly string[]) {
  const cited = new Set(
    current.evidence.flatMap((entry) => (entry.kind === "record" ? [entry.id] : [])),
  );
  return callIds
    .filter((id) => !cited.has(id))
    .map((id) => ({ collection: INVOCATIONS, id, kind: "record" as const }));
}

export function lastDecision(checkpoint: AgentCheckpoint): string | undefined {
  return checkpoint.decisions.at(-1);
}

import { createHash } from "node:crypto";

import {
  createFeltDB,
  openAgentState,
  type AgentCheckpoint,
  type AgentCheckpointInput,
  type AgentStateStore,
  type AgentTask,
} from "@feltdb/core";
import { defineState } from "eve/context";

export const AGENT_ID = "agent:appport-agent";
export const APPLICATION_SCOPE = "inventory";
export const INVOCATIONS = "appport_invocations";
const MAX_HISTORY = 50;

export const currentWork = defineState<string | null>("appport-agent.work", () => null);

type Database = ReturnType<typeof createFeltDB>;
let opened: Promise<{ db: Database; state: AgentStateStore }> | undefined;

const OPEN_ATTEMPTS = 50;
const OPEN_RETRY_MS = 200;

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

export function workIdFor(requester: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${requester}\n${idempotencyKey}`).digest("hex");
  return `work_${digest.slice(0, 32)}`;
}

export type Submission =
  | { readonly outcome: "accepted" | "replayed"; readonly task: AgentTask }
  | { readonly outcome: "conflict"; readonly task: AgentTask };

export async function acceptWork(
  requester: string,
  idempotencyKey: string,
  objective: string,
): Promise<Submission> {
  const { state } = await workStore();
  const taskId = workIdFor(requester, idempotencyKey);
  const existing = await state.getTask(taskId);
  if (existing !== null) {
    return {
      outcome: existing.task.objective === objective ? "replayed" : "conflict",
      task: existing.task,
    };
  }
  try {
    const { task } = await state.createTask({
      actor: AGENT_ID,
      objective,
      scope: { project: APPLICATION_SCOPE, workspace: requester },
      status: "ready",
      summary: `Accepted from ${requester}.`,
      taskId,
    });
    return { outcome: "accepted", task };
  } catch (error) {
    const raced = await state.getTask(taskId);
    if (raced === null) throw error;
    return {
      outcome: raced.task.objective === objective ? "replayed" : "conflict",
      task: raced.task,
    };
  }
}

export async function readWork(requester: string, workId: string) {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null || current.task.scope.workspace !== requester) return null;
  const history: AgentCheckpoint[] = [];
  const first = Math.max(1, current.task.checkpoint_version - MAX_HISTORY + 1);
  for (let version = first; version <= current.task.checkpoint_version; version += 1) {
    const checkpoint = await state.getCheckpoint(workId, version);
    if (checkpoint !== null) history.push(checkpoint);
  }
  const session = [...history].reverse().find((entry) => entry.execution?.conversation_id);
  const invocations = [];
  for (const entry of current.checkpoint.evidence) {
    if (entry.kind !== "record" || entry.collection !== INVOCATIONS) continue;
    const record = await readInvocation(entry.id);
    invocations.push({
      capability: record?.capability ?? null,
      errorCode: record?.error_code ?? null,
      ok: record?.ok === true,
      requestId: entry.id,
    });
  }
  return {
    agent: current.task.owner,
    createdAt: current.task.created_at,
    decisions: current.checkpoint.decisions,
    evidence: current.checkpoint.evidence,
    invocations,
    history: history.map((entry) => ({
      at: entry.created_at,
      decisions: entry.decisions,
      status: entry.status,
      summary: entry.summary,
      version: entry.version,
    })),
    objective: current.task.objective,
    requester: current.task.scope.workspace,
    scope: current.task.scope,
    sessionId: session?.execution?.conversation_id ?? null,
    status: current.task.status,
    summary: current.checkpoint.summary,
    updatedAt: current.task.updated_at,
    workId,
  };
}

export async function recordProgress(
  workId: string,
  input: Omit<AgentCheckpointInput, "actor">,
): Promise<boolean> {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null) return false;
  if (current.task.status === "completed" || current.task.status === "cancelled") return false;
  await state.checkpoint(workId, {
    ...input,
    actor: AGENT_ID,
    expectedVersion: current.task.checkpoint_version,
  });
  return true;
}

export async function workEvidence(workId: string): Promise<string[]> {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null) return [];
  return current.checkpoint.evidence
    .filter((entry) => entry.kind === "record" && entry.collection === INVOCATIONS)
    .map((entry) => (entry.kind === "record" ? entry.id : ""));
}

export interface InvocationEvidence {
  readonly agent: string;
  readonly capability: string;
  readonly caller: string;
  readonly errorCode: string | null;
  readonly ok: boolean;
  readonly outputDigest: string | null;
  readonly requestId: string;
  readonly workId: string;
}

export async function recordInvocation(evidence: InvocationEvidence): Promise<void> {
  const { db } = await workStore();
  await db.collection(INVOCATIONS).insert(
    {
      agent: evidence.agent,
      appport_provenance: `appport-provenance:${APPLICATION_SCOPE}/${evidence.requestId}`,
      capability: evidence.capability,
      caller: evidence.caller,
      error_code: evidence.errorCode,
      ok: evidence.ok,
      output_digest: evidence.outputDigest,
      recorded_at: new Date().toISOString(),
      request_id: evidence.requestId,
      work_id: evidence.workId,
    },
    evidence.requestId,
    { requireAbsent: true },
  );
}

export async function readInvocation(requestId: string) {
  const { db } = await workStore();
  return await db.collection<Record<string, unknown>>(INVOCATIONS).get(requestId);
}

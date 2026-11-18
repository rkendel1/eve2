import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "@appport/protocol";
import type { CapabilityManifestEntry } from "@appport/protocol";

import { sendRequest, type Caller, type InvocationResult } from "./appport";
import { fault } from "./faults";
import {
  AGENT_ID,
  CALLS,
  OPERATIONS,
  callLinkId,
  readCallLink,
  workStore,
  type ObservedCall,
  type Outcome,
} from "./work";

const PROCESS_ID = randomUUID();
const OPERATION_KEY = /^[A-Za-z0-9._-]{1,64}$/u;
const NOT_EXECUTED = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "UNKNOWN_CAPABILITY",
  "UNSUPPORTED_CAPABILITY_VERSION",
]);
const inFlight = new Map<string, Promise<OperationRecord>>();

export type OperationState = "prepared" | "executing" | "succeeded" | "failed" | "indeterminate";
export type RetrySafety = "idempotency-key" | "observation" | "none";

export interface OperationRecord {
  readonly __version?: number;
  readonly agent: string;
  readonly attempts: number;
  readonly capability: string;
  readonly capability_version: number;
  readonly created_at: string;
  readonly executor: string | null;
  readonly idempotency_key: string | null;
  readonly input_digest: string;
  readonly operation_id: string;
  readonly operation_key: string | null;
  readonly outcome: {
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly ok: boolean;
    readonly output: unknown;
    readonly output_digest: string | null;
    readonly reconciled_after_interruption: boolean;
    readonly request_id: string;
  } | null;
  readonly request_ids: readonly string[];
  readonly requester: string;
  readonly resolution: string | null;
  readonly retry_safety: RetrySafety;
  readonly state: OperationState;
  readonly updated_at: string;
  readonly work_id: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function inputDigest(entry: CapabilityManifestEntry, input: unknown): string {
  return `sha256:${digest(canonicalize({ capability: entry.name, input, version: entry.latestVersion }))}`;
}

export function operationIdFor(
  workId: string,
  capability: string,
  operationKey: string | undefined,
  fingerprint: string,
): string {
  const identity = operationKey === undefined ? `input:${fingerprint}` : `key:${operationKey}`;
  return `op_${digest(`${workId}\n${capability}\n${identity}`).slice(0, 40)}`;
}

function retrySafetyOf(entry: CapabilityManifestEntry): RetrySafety {
  if (entry.idempotency === "supported") return "idempotency-key";
  if (entry.effect === "observation") return "observation";
  return "none";
}

export async function readOperation(operationId: string): Promise<OperationRecord | null> {
  const { db } = await workStore();
  const record = await db.collection<OperationRecord>(OPERATIONS).get(operationId);
  return record;
}

async function transition(
  current: OperationRecord,
  changes: Partial<OperationRecord>,
): Promise<OperationRecord> {
  const { db } = await workStore();
  const result = await db
    .collection<OperationRecord>(OPERATIONS)
    .updateIfVersion(current.operation_id, current.__version ?? 0, {
      ...changes,
      updated_at: new Date().toISOString(),
    });
  if (!result.updated || result.item === undefined) {
    throw new Error(`Operation ${current.operation_id} changed underneath this attempt.`);
  }
  return result.item;
}

export interface OperationRequest {
  readonly callId: string;
  readonly caller: Caller;
  readonly entry: CapabilityManifestEntry;
  readonly input: unknown;
  readonly objective: string;
  readonly operationKey: string | undefined;
  readonly workId: string;
}

export type OperationResult =
  | { readonly kind: "conflict"; readonly operationId: string; readonly message: string }
  | { readonly kind: "recorded"; readonly invoked: boolean; readonly operation: OperationRecord };

export async function runOperation(request: OperationRequest): Promise<OperationResult> {
  const { db } = await workStore();
  if (request.operationKey !== undefined && !OPERATION_KEY.test(request.operationKey)) {
    await linkCall(request.workId, request.callId, null, "INVALID_OPERATION_KEY");
    return {
      kind: "conflict",
      message: "operationKey must be 1-64 characters of [A-Za-z0-9._-].",
      operationId: "",
    };
  }
  const fingerprint = inputDigest(request.entry, request.input);
  const operationId = operationIdFor(
    request.workId,
    request.entry.name,
    request.operationKey,
    fingerprint,
  );

  const operations = db.collection<OperationRecord>(OPERATIONS);
  if ((await operations.get(operationId)) === null) {
    const now = new Date().toISOString();
    const safety = retrySafetyOf(request.entry);
    try {
      await operations.insert(
        {
          agent: AGENT_ID,
          attempts: 0,
          capability: request.entry.name,
          capability_version: request.entry.latestVersion,
          created_at: now,
          executor: null,
          idempotency_key: safety === "idempotency-key" ? operationId : null,
          input_digest: fingerprint,
          operation_id: operationId,
          operation_key: request.operationKey ?? null,
          outcome: null,
          request_ids: [],
          requester: request.caller.principalId,
          resolution: null,
          retry_safety: safety,
          state: "prepared",
          updated_at: now,
          work_id: request.workId,
        },
        operationId,
        { requireAbsent: true },
      );
    } catch (error) {
      if ((await operations.get(operationId)) === null) throw error;
    }
  }
  const existing = await operations.get(operationId);
  if (existing === null) throw new Error(`Operation ${operationId} was not recorded.`);
  if (existing.capability !== request.entry.name || existing.input_digest !== fingerprint) {
    await linkCall(request.workId, request.callId, null, "OPERATION_CONFLICT");
    return {
      kind: "conflict",
      message: `Operation ${operationId} was recorded for ${existing.capability} with different input; it is never overwritten.`,
      operationId,
    };
  }

  await linkCall(request.workId, request.callId, operationId);
  const running = inFlight.get(operationId);
  if (running !== undefined) return { invoked: false, kind: "recorded", operation: await running };
  const attempt = attempt_(existing, request);
  inFlight.set(
    operationId,
    attempt.then((result) => result.operation),
  );
  try {
    return await attempt;
  } finally {
    inFlight.delete(operationId);
  }
}

async function attempt_(
  existing: OperationRecord,
  request: OperationRequest,
): Promise<{ kind: "recorded"; invoked: boolean; operation: OperationRecord }> {
  let current = existing;
  const settled = { invoked: false, kind: "recorded" as const };
  if (
    current.state === "succeeded" ||
    current.state === "failed" ||
    current.state === "indeterminate"
  ) {
    return { ...settled, operation: current };
  }
  const reconciling = current.state === "executing";
  if (reconciling && current.retry_safety === "none") {
    return {
      ...settled,
      operation: await transition(current, {
        executor: null,
        resolution:
          "The attempt that started this operation stopped before its outcome was recorded, and the capability offers no idempotency key. It is not retried automatically; a person must establish whether it took effect.",
        state: "indeterminate",
      }),
    };
  }

  await fault("operation.prepared", { objective: request.objective, workId: request.workId });
  current = await transition(current, {
    attempts: current.attempts + 1,
    executor: PROCESS_ID,
    state: "executing",
  });

  const result: InvocationResult = await sendRequest(
    request.caller,
    request.entry,
    request.input,
    request.workId,
    current.idempotency_key ?? undefined,
  );
  await fault("invocation.record", { objective: request.objective, workId: request.workId });

  const requestIds = [...current.request_ids, result.requestId];
  const outcome = {
    error: result.ok ? null : { code: result.error.code, message: result.error.message },
    ok: result.ok,
    output: result.ok ? result.output : null,
    output_digest: result.ok ? `sha256:${digest(canonicalize(result.output ?? null))}` : null,
    reconciled_after_interruption: reconciling,
    request_id: result.requestId,
  };
  if (result.ok) {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        state: "succeeded",
      }),
    };
  }
  if (NOT_EXECUTED.has(result.error.code)) {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        state: "failed",
      }),
    };
  }
  if (result.error.code === "UNAVAILABLE" && current.retry_safety !== "none") {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        resolution:
          "AppPort did not answer; a later attempt reconciles it with the same idempotency key or a repeated read.",
      }),
    };
  }
  return {
    ...settled,
    invoked: true,
    operation: await transition(current, {
      executor: null,
      outcome,
      request_ids: requestIds,
      resolution: `AppPort answered ${result.error.code}; whether the capability took effect is not established. It is not retried automatically.`,
      state: "indeterminate",
    }),
  };
}

export async function settleAbandoned(operationId: string): Promise<OperationRecord | null> {
  const current = await readOperation(operationId);
  if (current === null || current.state !== "executing" || current.retry_safety !== "none")
    return current;
  if (current.executor === PROCESS_ID || inFlight.has(operationId)) return current;
  return await transition(current, {
    executor: null,
    resolution:
      "The attempt that started this operation stopped before its outcome was recorded, and the capability offers no idempotency key. It is not retried automatically; a person must establish whether it took effect.",
    state: "indeterminate",
  });
}

async function linkCall(
  workId: string,
  callId: string,
  operationId: string | null,
  refusal?: string,
) {
  const { db } = await workStore();
  const calls = db.collection<Record<string, unknown>>(CALLS);
  const id = callLinkId(workId, callId);
  if ((await calls.get(id)) !== null) return;
  await calls.insert(
    {
      call_id: callId,
      operation_id: operationId,
      recorded_at: new Date().toISOString(),
      refusal: refusal ?? null,
      work_id: workId,
    },
    id,
    { requireAbsent: true },
  );
}

export async function recordRefusedCall(workId: string, callId: string, code: string) {
  await linkCall(workId, callId, null, code);
}

export async function decideOutcome(
  workId: string,
  turnOutcome: string,
  invokeCalls: readonly ObservedCall[],
  reply: string,
): Promise<Outcome> {
  const said = reply.length > 0 ? ` Agent reply: ${reply.slice(0, 2000)}` : "";
  const resolved = new Map<string, boolean>();
  const unresolved = new Set<string>();
  let refused = 0;
  for (const call of invokeCalls) {
    const link = await readCallLink(workId, call.callId);
    if (link === null) {
      if (call.settled) unresolved.add(`call:${call.callId}`);
      continue;
    }
    if (link.operation_id === null) {
      refused += 1;
      continue;
    }
    const operation = await settleAbandoned(String(link.operation_id));
    if (operation === null || operation.work_id !== workId) unresolved.add(`call:${call.callId}`);
    else if (operation.state === "succeeded") resolved.set(operation.operation_id, true);
    else if (operation.state === "failed") resolved.set(operation.operation_id, false);
    else if (call.settled || operation.state === "indeterminate")
      unresolved.add(operation.operation_id);
  }
  for (const id of resolved.keys()) unresolved.delete(id);
  const evidence = [...resolved.keys()];
  const succeeded = [...resolved.values()].filter(Boolean).length;
  if (turnOutcome !== "completed") {
    return {
      decision: `failed: the eve turn ended ${turnOutcome}`,
      evidence,
      status: "blocked",
      summary: `Failed: the eve turn ended ${turnOutcome}.`,
    };
  }
  if (unresolved.size > 0) {
    return {
      decision: `indeterminate: ${unresolved.size} AppPort operation(s) without an established outcome`,
      evidence,
      status: "blocked",
      summary: `Indeterminate: ${unresolved.size} AppPort operation(s) have no established outcome and are not retried automatically.`,
    };
  }
  if (resolved.size + refused > 0 && succeeded === 0) {
    return {
      decision: "waiting: every AppPort invocation was rejected",
      evidence,
      status: "blocked",
      summary: `Blocked: no capability invocation was authorized.${said}`,
    };
  }
  return {
    decision: `completed after ${succeeded} authorized invocation(s)`,
    evidence,
    status: "completed",
    summary: `Completed after ${succeeded} authorized invocation(s).${said}`,
  };
}

import type { SessionCapabilities } from "#channel/types.js";
import { isObject } from "#shared/guards.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionTransferState,
} from "#execution/session/checkpoint.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { OpenTurn, SessionCheckpointSink } from "#execution/session/turn.js";
import { findTask, readTaskTable } from "#execution/tasks/table.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

export interface DurableSessionStore {
  appendLine(sessionId: string, index: number, line: string): Promise<void>;
  readLines(sessionId: string): Promise<readonly string[]>;
  saveSession(sessionId: string, record: string): Promise<void>;
  readSessions(): Promise<readonly { readonly sessionId: string; readonly record: string }[]>;
}

export const STORED_SESSION_VERSION = 1;

export interface StoredSession {
  readonly version: typeof STORED_SESSION_VERSION;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly ownerKey: string | null | { readonly root: string };
  readonly capabilities?: SessionCapabilities;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionTimeoutMs: number | false;
  readonly checkpoint?: SessionCheckpoint;
  readonly openTurn?: OpenTurn;
  readonly launches?: readonly StoredLaunch[];
  readonly ended?: true;
}

export interface StoredLaunch {
  readonly runId: string;
  readonly taskId: string;
  readonly input: WorkflowToolRunInput;
  readonly child?: string;
}

export type TrackedSession = Pick<
  StoredSession,
  "capabilities" | "continuationToken" | "ownerKey" | "retention" | "sessionId" | "sessionTimeoutMs"
>;

export class UnstorableSessionValueError extends Error {
  constructor(path: string, what: string) {
    super(`Session state at ${path} is ${what}, which the session store cannot keep exactly.`);
    this.name = "UnstorableSessionValueError";
  }
}

const BYTES = "$eve:bytes";
const DATE = "$eve:date";
const HEX = "0123456789abcdef";

function encodeValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnstorableSessionValueError(path, String(value));
    return value;
  }
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const byte of value) hex += HEX[byte >> 4]! + HEX[byte & 15]!;
    return { [BYTES]: hex };
  }
  if (value instanceof Date) return { [DATE]: value.toISOString() };
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined)
        throw new UnstorableSessionValueError(`${path}[${index}]`, "undefined");
      return encodeValue(item, `${path}[${index}]`);
    });
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnstorableSessionValueError(path, `a ${prototype?.constructor?.name ?? "class"}`);
    }
    const encoded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === BYTES || key === DATE)
        throw new UnstorableSessionValueError(path, `a "${key}" key`);
      const next = encodeValue(item, `${path}.${key}`);
      if (next !== undefined) encoded[key] = next;
    }
    return encoded;
  }
  throw new UnstorableSessionValueError(path, `a ${typeof value}`);
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record[BYTES] === "string" && Object.keys(record).length === 1) {
    const hex = record[BYTES] as string;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (typeof record[DATE] === "string" && Object.keys(record).length === 1) {
    return new Date(record[DATE] as string);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeValue(item)]));
}

export function encodeStoredSession(session: StoredSession): string {
  return JSON.stringify(encodeValue(session, "session"));
}

export function decodeStoredSession(record: string): StoredSession {
  const session = decodeValue(JSON.parse(record)) as StoredSession;
  if (session.version !== STORED_SESSION_VERSION) {
    throw new Error(
      `Session record version ${String(session.version)} is not one this eve reads (${STORED_SESSION_VERSION}).`,
    );
  }
  assertContinuation(session);
  return session;
}

function assertContinuation(session: StoredSession): void {
  const { dispatched, step, waiting } = (session.openTurn ?? {}) as Record<string, unknown>;
  const valid =
    (waiting === undefined || isWaiting(waiting)) &&
    (step === undefined || (isObject(step) && isResults(step.runtimeResults, true))) &&
    (dispatched === undefined ||
      (isObject(dispatched) &&
        isResults(dispatched, false) &&
        isObject(dispatched.pending) &&
        ["executing", "refused", "started"].every((key) =>
          Array.isArray((dispatched.pending as Record<string, unknown>)[key]),
        )));
  if (!valid) {
    throw new Error(
      `Session ${session.sessionId} was interrupted mid-turn, and its stored continuation is not one eve can read. eve did not resume the turn, to avoid repeating or skipping its work.`,
    );
  }
}

function isWaiting(waiting: unknown): boolean {
  if (!isObject(waiting) || !isStrings(waiting.on === "tasks" ? waiting.taskIds : waiting.callIds))
    return false;
  return (
    waiting.on === "tasks" ||
    (waiting.on === "calls" &&
      typeof waiting.dispatch === "boolean" &&
      Array.isArray(waiting.taskToolCalls))
  );
}

function isResults(holder: unknown, optional: boolean): boolean {
  if (holder === undefined) return optional;
  const results = isObject(holder) ? holder.results : undefined;
  return (
    Array.isArray(results) &&
    results.every(
      (result: unknown) =>
        isObject(result) && typeof result.callId === "string" && typeof result.kind === "string",
    )
  );
}

function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkpointOf(session: StoredSession, state: SessionTransferState): SessionCheckpoint {
  return {
    admittedDeliveryKeys: state.admittedDeliveryKeys,
    capabilities: session.capabilities,
    history: state.history,
    retention: session.retention,
    serializedContext: state.serializedContext,
    sessionState: state.sessionState,
    sessionTimeoutMs: session.sessionTimeoutMs,
    version: SESSION_CHECKPOINT_VERSION,
  };
}

export interface SessionPersistence extends SessionCheckpointSink {
  track(
    session: TrackedSession,
    first?: { readonly state: SessionTransferState; readonly openTurn?: OpenTurn },
  ): Promise<void>;
  ended(sessionId: string): Promise<void>;
  deferLaunch(sessionId: string, launch: StoredLaunch, start: () => void): boolean;
  acknowledgeChild(parentSessionId: string, callId: string, childSessionId: string): Promise<void>;
}

export function createSessionPersistence(store: DurableSessionStore): SessionPersistence {
  const tracked = new Map<string, StoredSession>();
  const deferred = new Map<string, { launch: StoredLaunch; start: () => void }[]>();
  const writes = new Map<string, Promise<void>>();
  const save = async (session: StoredSession) => {
    tracked.set(session.sessionId, session);
    const record = encodeStoredSession(session);
    const written = (writes.get(session.sessionId) ?? Promise.resolve()).then(() =>
      store.saveSession(session.sessionId, record),
    );
    writes.set(
      session.sessionId,
      written.catch(() => {}),
    );
    await written;
  };
  return {
    async track(session, first) {
      const stored: StoredSession = {
        ...tracked.get(session.sessionId),
        ...session,
        version: STORED_SESSION_VERSION,
      };
      await save(
        first === undefined
          ? stored
          : {
              ...stored,
              checkpoint: checkpointOf(stored, first.state),
              ...(first.openTurn !== undefined && { openTurn: first.openTurn }),
            },
      );
    },
    deferLaunch(sessionId, launch, start) {
      const session = tracked.get(sessionId);
      if (session === undefined || session.ended === true) return false;
      deferred.set(sessionId, [...(deferred.get(sessionId) ?? []), { launch, start }]);
      return true;
    },
    async acknowledgeChild(parentSessionId, callId, childSessionId) {
      const parent = tracked.get(parentSessionId);
      const awaiting = (launch: StoredLaunch) =>
        launch.input.callId === callId && launch.child === undefined;
      if (parent?.launches?.some(awaiting) !== true) return;
      await save({
        ...parent,
        launches: parent.launches.map((launch) =>
          awaiting(launch) ? { ...launch, child: childSessionId } : launch,
        ),
      });
    },
    async checkpoint(state: SessionTransferState, openTurn?: OpenTurn) {
      const session = tracked.get(state.sessionState.sessionId);
      if (session === undefined || session.ended === true) return;
      const { openTurn: _previous, launches: previous, ...rest } = session;
      const starting = deferred.get(session.sessionId) ?? [];
      deferred.delete(session.sessionId);
      const table = readTaskTable(readDurableSession(state.sessionState).state);
      const launches = [...(previous ?? []), ...starting.map(({ launch }) => launch)].filter(
        ({ runId, taskId }) => {
          const task = findTask(table, taskId);
          return task?.run?.runId === runId && task.calls.length > 0;
        },
      );
      await save({
        ...rest,
        checkpoint: checkpointOf(session, state),
        ...(openTurn !== undefined && { openTurn }),
        ...(launches.length > 0 && { launches }),
      });
      for (const { start } of starting) start();
    },
    async ended(sessionId) {
      const session = tracked.get(sessionId);
      if (session === undefined) return;
      await save({ ...session, ended: true });
    },
  };
}

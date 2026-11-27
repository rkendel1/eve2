import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionTransferState,
} from "#execution/session/checkpoint.js";
import type { SessionCheckpointSink } from "#execution/session/turn.js";
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
  readonly openTurn?: { readonly delivery?: DeliverHookPayload };
  readonly ended?: true;
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
  return session;
}

export interface SessionPersistence extends SessionCheckpointSink {
  track(session: TrackedSession): Promise<void>;
  ended(sessionId: string): Promise<void>;
}

export function createSessionPersistence(store: DurableSessionStore): SessionPersistence {
  const tracked = new Map<string, StoredSession>();
  const save = async (session: StoredSession) => {
    tracked.set(session.sessionId, session);
    await store.saveSession(session.sessionId, encodeStoredSession(session));
  };
  return {
    async track(session) {
      await save({
        ...tracked.get(session.sessionId),
        ...session,
        version: STORED_SESSION_VERSION,
      });
    },
    async checkpoint(
      state: SessionTransferState,
      openTurn?: { readonly delivery?: DeliverHookPayload },
    ) {
      const session = tracked.get(state.sessionState.sessionId);
      if (session === undefined || session.ended === true) return;
      const { openTurn: _previous, ...rest } = session;
      await save({
        ...rest,
        checkpoint: {
          admittedDeliveryKeys: state.admittedDeliveryKeys,
          capabilities: session.capabilities,
          history: state.history,
          retention: session.retention,
          serializedContext: state.serializedContext,
          sessionState: state.sessionState,
          sessionTimeoutMs: session.sessionTimeoutMs,
          version: SESSION_CHECKPOINT_VERSION,
        },
        ...(openTurn !== undefined && { openTurn }),
      });
    },
    async ended(sessionId) {
      const session = tracked.get(sessionId);
      if (session === undefined) return;
      await save({ ...session, ended: true });
    },
  };
}

import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import type { PayloadRef, PayloadStore } from "../payload/types.js";

export const COLLECTIONS = {
  runs: "wf_runs",
  events: "wf_events",
  steps: "wf_steps",
  waits: "wf_waits",
  hooks: "wf_hooks",
  hookDisposals: "wf_hook_disposals",
  hookTokens: "wf_hook_tokens",
  hookResumes: "wf_hook_resumes",
  startHookRejections: "wf_start_hook_rejections",
  streamChunks: "wf_stream_chunks",
  snapshots: "wf_snapshots",
  messages: "wf_messages",
  messageKeys: "wf_message_keys",
  runDelivery: "wf_run_delivery",
  memory: "eve_memory",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

const INDEXES: Array<{ collection: CollectionName; name: string; fields: string[] }> = [
  { collection: COLLECTIONS.runs, name: "runs_by_created", fields: ["createdAt", "runId"] },
  {
    collection: COLLECTIONS.runs,
    name: "runs_by_status",
    fields: ["status", "createdAt", "runId"],
  },
  { collection: COLLECTIONS.events, name: "events_by_run", fields: ["runId", "seq"] },
  {
    collection: COLLECTIONS.events,
    name: "events_by_correlation",
    fields: ["runId", "correlationId", "seq"],
  },
  { collection: COLLECTIONS.steps, name: "steps_by_run", fields: ["runId", "createdAt", "stepId"] },
  { collection: COLLECTIONS.waits, name: "waits_by_run", fields: ["runId", "waitId"] },
  { collection: COLLECTIONS.hooks, name: "hooks_by_run", fields: ["runId", "hookId"] },
  { collection: COLLECTIONS.hooks, name: "hooks_by_token", fields: ["token", "hookId"] },
  { collection: COLLECTIONS.hooks, name: "hooks_by_created", fields: ["createdAt", "hookId"] },
  { collection: COLLECTIONS.hookDisposals, name: "disposals_by_run", fields: ["runId", "hookId"] },
  { collection: COLLECTIONS.hookTokens, name: "tokens_by_run", fields: ["runId", "token"] },
  { collection: COLLECTIONS.streamChunks, name: "chunks_by_name", fields: ["name", "idx"] },
  { collection: COLLECTIONS.streamChunks, name: "chunks_by_run", fields: ["runId", "name", "idx"] },
  {
    collection: COLLECTIONS.messages,
    name: "messages_by_visibility",
    fields: ["state", "visibleAt", "messageId"],
  },
  { collection: COLLECTIONS.messages, name: "messages_by_run", fields: ["runId", "messageId"] },
];

const PLAIN_ID = /^[A-Za-z0-9_-]{1,60}$/;

export function keyPart(value: string): string {
  return PLAIN_ID.test(value) ? value : `x${createHash("sha256").update(value).digest("hex")}`;
}

export function joinKey(...parts: Array<string | number>): string {
  return parts.map((part) => (typeof part === "number" ? padSeq(part) : keyPart(part))).join(".");
}

export function padSeq(seq: number): string {
  return String(seq).padStart(12, "0");
}

export type FeltRecord = Record<string, unknown> & { __version?: number };

type Staged = { value: Record<string, unknown> | null; guardRead: boolean };

const DOC_FIELDS = ["doc", "envelope", "data"] as const;

export class WorldTransactionAborted extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("the World transaction was refused by FeltDB");
    this.cause = cause;
  }
}

export class Unit {
  readonly #database: WorldDatabase;
  readonly #reads = new Map<string, number | null>();
  readonly #writes = new Map<string, Staged>();

  constructor(database: WorldDatabase) {
    this.#database = database;
  }

  async get(collection: CollectionName, id: string): Promise<FeltRecord | null> {
    const key = `${collection}\u0000${id}`;
    const staged = this.#writes.get(key);
    if (staged) return staged.value === null ? null : { ...staged.value };
    const record = await this.#database.read(collection, id);
    if (!this.#reads.has(key)) this.#reads.set(key, record ? (record.__version ?? 0) : null);
    return record;
  }

  set(collection: CollectionName, id: string, value: Record<string, unknown>): void {
    this.#writes.set(`${collection}\u0000${id}`, {
      value: withoutInternalFields(value),
      guardRead: true,
    });
  }

  delete(collection: CollectionName, id: string): void {
    this.#writes.set(`${collection}\u0000${id}`, { value: null, guardRead: true });
  }

  stagedIn(
    collection: CollectionName,
  ): Array<{ id: string; value: Record<string, unknown> | null }> {
    const prefix = `${collection}\u0000`;
    const staged: Array<{ id: string; value: Record<string, unknown> | null }> = [];
    for (const [key, entry] of this.#writes) {
      if (key.startsWith(prefix)) staged.push({ id: key.slice(prefix.length), value: entry.value });
    }
    return staged;
  }

  get empty(): boolean {
    return this.#writes.size === 0;
  }

  async commit(): Promise<void> {
    if (this.#writes.size === 0) return;
    const database = this.#database;
    for (const key of this.#writes.keys()) {
      if (this.#reads.has(key)) continue;
      const [collection, id] = splitKey(key);
      const record = await database.read(collection, id);
      this.#reads.set(key, record ? (record.__version ?? 0) : null);
    }
    const guards: Array<{ collection: string; id: string; ifVersion: number }> = [];
    const operations: Array<{
      collection: CollectionName;
      id: string;
      value: Record<string, unknown> | null;
      version: number | null;
    }> = [];
    for (const [key, staged] of this.#writes) {
      const [collection, id] = splitKey(key);
      const version = this.#reads.get(key) ?? null;
      if (staged.value === null) {
        if (version === null) continue;
        operations.push({ collection, id, value: null, version });
        continue;
      }
      const value = await database.externalize(staged.value, guards);
      operations.push({ collection, id, value, version });
    }
    for (const [key, version] of this.#reads) {
      if (this.#writes.has(key)) continue;
      const [collection, id] = splitKey(key);
      operations.push({ collection, id, value: undefined as never, version });
    }
    try {
      await database.db.transaction((tx) => {
        for (const guard of guards) tx.require(guard);
        for (const operation of operations) {
          const target = tx.collection(operation.collection);
          if (operation.value === undefined) {
            tx.require(
              operation.version === null
                ? { collection: operation.collection, id: operation.id, requireAbsent: true }
                : {
                    collection: operation.collection,
                    id: operation.id,
                    ifVersion: operation.version,
                  },
            );
          } else if (operation.value === null) {
            target.delete(operation.id, { ifVersion: operation.version! });
          } else if (operation.version === null) {
            target.set(operation.id, operation.value, { requireAbsent: true });
          } else {
            target.set(operation.id, operation.value, { ifVersion: operation.version });
          }
        }
      });
    } catch (error) {
      throw new WorldTransactionAborted(error);
    }
  }
}

function withoutInternalFields(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!field.startsWith("__") && field !== "id" && fieldValue !== undefined)
      copy[field] = fieldValue;
  }
  return copy;
}

function splitKey(key: string): [CollectionName, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator) as CollectionName, key.slice(separator + 1)];
}

export interface WorldDatabaseOptions {
  db: StateFirstDB;
  payloads: PayloadStore;
  inlineDocBytes?: number;
}

export class WorldDatabase {
  readonly db: StateFirstDB;
  readonly payloads: PayloadStore;
  readonly inlineDocBytes: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: WorldDatabaseOptions) {
    this.db = options.db;
    this.payloads = options.payloads;
    this.inlineDocBytes = options.inlineDocBytes ?? 1024;
    for (const index of INDEXES) {
      const collection = this.db.collection(index.collection);
      if (collection.listIndexes().some((existing) => existing.name === index.name)) continue;
      collection.createIndex({ name: index.name, type: "compound", fields: index.fields });
    }
  }

  async read(collection: CollectionName, id: string): Promise<FeltRecord | null> {
    return ((await this.db.collection(collection).get(id)) as FeltRecord | null) ?? null;
  }

  async query(
    collection: CollectionName,
    where: Array<{ field: string } & Record<string, unknown>>,
    options: {
      orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ records: FeltRecord[]; nextCursor?: string; exhausted: boolean }> {
    const page = await this.db.query({
      collection,
      where: where as never,
      orderBy: options.orderBy,
      limit: options.limit,
      cursor: options.cursor,
    });
    return {
      records: page.records as FeltRecord[],
      nextCursor: page.nextCursor,
      exhausted: page.exhausted,
    };
  }

  async *scan(
    collection: CollectionName,
    where: Array<{ field: string } & Record<string, unknown>>,
    orderBy?: Array<{ field: string; direction: "asc" | "desc" }>,
  ): AsyncIterable<FeltRecord> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.query(collection, where, { orderBy, limit: 1000, cursor });
      for (const record of page.records) yield record;
      if (page.exhausted || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  async transact<T>(body: (unit: Unit) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const unit = new Unit(this);
      const result = await body(unit);
      await unit.commit();
      if (result instanceof CommitThenThrow) throw result.error;
      return result;
    });
  }

  async snapshot<T>(body: () => Promise<T>): Promise<T> {
    return this.exclusive(body);
  }

  async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(body, body);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async externalize(
    value: Record<string, unknown>,
    guards: Array<{ collection: string; id: string; ifVersion: number }>,
  ): Promise<Record<string, unknown>> {
    let result = value;
    for (const field of DOC_FIELDS) {
      const doc = value[field];
      if (typeof doc !== "string" || Buffer.byteLength(doc) <= this.inlineDocBytes) continue;
      const ref = await this.payloads.write(Buffer.from(doc, "utf8"));
      guards.push(await this.payloads.guard(ref));
      result = { ...result, [field]: undefined, [`${field}Ref`]: { ...ref } };
      delete result[field];
    }
    return result;
  }

  async internalize(
    record: FeltRecord,
    field: (typeof DOC_FIELDS)[number],
  ): Promise<string | null> {
    const inline = record[field];
    if (typeof inline === "string") return inline;
    const ref = record[`${field}Ref`] as PayloadRef | undefined;
    if (!ref) return null;
    return Buffer.from(await this.payloads.read(ref)).toString("utf8");
  }
}

export class CommitThenThrow extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super("commit, then throw");
    this.error = error;
  }
}

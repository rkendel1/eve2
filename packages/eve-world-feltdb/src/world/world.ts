import path from "node:path";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import type { QueuePrefix, World, WorldCapabilities } from "@workflow/world";
import { mintedSpecVersion, reenqueueActiveRuns } from "@workflow/world";
import { feltdbContentPayloads } from "../payload/content-store.js";
import { folderPayloads } from "../payload/folder-store.js";
import { feltdbRecordPayloads } from "../payload/record-store.js";
import type { PayloadStore } from "../payload/types.js";
import { type Config, config as defaultConfig } from "./config.js";
import { COLLECTIONS, keyPart, WorldDatabase } from "./database.js";
import { createQueue, type DirectHandler } from "./queue.js";
import { createQueueAuthKey } from "./queue-auth-key.js";
import { QueueRecords } from "./queue-records.js";
import { createStorage } from "./storage.js";
import { createStreamer } from "./streamer.js";

/** How long the World asks FeltDB to recognize a committed transaction id, in store time: 24 hours. */
export const DEFAULT_TRANSACTION_ID_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The Workflow World capabilities this World declares. */
export const FELTDB_WORLD_CAPABILITIES = {
  hookRetention: { active: true },
  atomicStartHook: { active: true },
  dynamicWorkflowCode: true,
  hookResumeDedup: true,
  hookForceClaim: true,
  maxConcurrency: true,
  inBandFence: true,
} satisfies WorldCapabilities;

/** Where `createWorld()` keeps payload bytes (`EVE_FELTDB_PAYLOADS`). */
export type PayloadBackend = "folder" | "feltdb-record" | "feltdb-content";

/** Options for {@link createFeltDBWorld}, for a host that opens the FeltDB database itself. */
export interface FeltDBWorldOptions {
  db: StateFirstDB;
  dataDir: string;
  payloads?: PayloadStore;
  transactionIdRetentionMs?: number;
  inlineDocBytes?: number;
  tag?: string;
  config?: Partial<Config>;
}

/** eve's Workflow World on FeltDB, with the in-process delivery hooks eve registers and its FeltDB settings. */
export type FeltDBWorld = World & {
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  registerRoute(prefix: QueuePrefix, path: string): void;
  readonly feltdb: {
    readonly transactionIdRetentionMs: number;
    readonly payloadBackend: string;
    readonly dataDir: string;
  };
};

/** The World cannot run on the database or configuration it was given; the message says what to change. */
export class FeltDBWorldConfigurationError extends Error {
  override readonly name = "FeltDBWorldConfigurationError";
}

/**
 * Refuses a FeltDB database that does not bound transaction ids with exactly `retainMs`: a
 * runtime without `transactionIdRetention` (a FeltDB server, the browser) or one opened with
 * another window.
 */
export async function requireTransactionIdRetention(
  db: StateFirstDB,
  retainMs: number,
): Promise<void> {
  if (db.capabilities().transactionIdRetention !== true) {
    throw new FeltDBWorldConfigurationError(
      "eve's FeltDB World needs a FeltDB runtime that bounds transaction ids (db.capabilities().transactionIdRetention): the Node file or memory runtime of @feltdb/core 0.25.0 or later. A FeltDB server or the browser runtime keeps every id and is refused.",
    );
  }
  const status = await db.journalStatus();
  if (status.transactionIds?.retainMs !== retainMs) {
    throw new FeltDBWorldConfigurationError(
      `eve's FeltDB World needs journal.retainTransactionIdsMs = ${retainMs} on its database, but the database reports ${String(status.transactionIds?.retainMs ?? "none")}. Open it with createFeltDB({ journal: { retainTransactionIdsMs: ${retainMs} } }).`,
    );
  }
}

/**
 * A World over a FeltDB database the caller opened (with `journal.retainTransactionIdsMs`),
 * keeping its payloads and queue key under `dataDir`. `start()` checks the retention, then resumes
 * every persisted queue message and re-enqueues active runs.
 */
export function createFeltDBWorld(options: FeltDBWorldOptions): FeltDBWorld {
  const retainMs = options.transactionIdRetentionMs ?? DEFAULT_TRANSACTION_ID_RETENTION_MS;
  const payloads =
    options.payloads ??
    folderPayloads({ db: options.db, root: path.join(options.dataDir, "payloads") });
  const database = new WorldDatabase({
    db: options.db,
    payloads,
    inlineDocBytes: options.inlineDocBytes,
  });
  const mergedConfig = { ...defaultConfig.value, ...options.config, dataDir: options.dataDir };
  const tag = options.tag ?? mergedConfig.tag;
  const queueAuthKey = createQueueAuthKey(
    mergedConfig.dataDir,
    mergedConfig.queueAuthKey ?? "regenerate",
  );
  const { clearCache: _clearStorageCache, ...storage } = createStorage(database, tag);
  const queue = createQueue(mergedConfig, {
    queueAuthKey,
    records: new QueueRecords(database),
    runSeq: async (runId) => {
      const record = await database.read(COLLECTIONS.runs, keyPart(runId));
      return record ? Number(record.seq ?? 0) : undefined;
    },
    ...(mergedConfig.readUnstampedRunSpec !== false && {
      runSpecVersion: async (runId: string) => {
        try {
          return (await storage.runs.get(runId, { resolveData: "none" })).specVersion;
        } catch {
          return undefined;
        }
      },
    }),
  });
  const { clearCache: _clearStreamerCache, ...streamer } = createStreamer(database, tag);
  const capabilities = FELTDB_WORLD_CAPABILITIES;
  let started = false;
  return {
    specVersion: mintedSpecVersion(process.env, { inBandFence: capabilities.inBandFence }),
    capabilities,
    ...queue,
    ...storage,
    ...streamer,
    ...(mergedConfig.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: mergedConfig.streamFlushIntervalMs,
    }),
    feltdb: {
      transactionIdRetentionMs: retainMs,
      payloadBackend: payloads.kind,
      dataDir: mergedConfig.dataDir,
    },
    async start() {
      if (started) return;
      started = true;
      await requireTransactionIdRetention(options.db, retainMs);
      await queueAuthKey.written();
      await queue.resumeStored();
      await reenqueueActiveRuns(
        {
          ...storage.runs,
          list: ((params) =>
            storage.runs.list({ ...params, ownTagOnly: true })) as typeof storage.runs.list,
        },
        queue.queue,
        "world-feltdb",
        undefined,
        { queueLost: false },
      );
    },
    async close() {
      await queue.close();
      await queueAuthKey.current().catch(() => undefined);
      await options.db.close();
    },
  } as FeltDBWorld;
}

function payloadsFor(backend: string, db: StateFirstDB, dataDir: string): PayloadStore {
  if (backend === "folder") return folderPayloads({ db, root: path.join(dataDir, "payloads") });
  if (backend === "feltdb-record") return feltdbRecordPayloads({ db });
  if (backend === "feltdb-content") return feltdbContentPayloads({ db });
  throw new FeltDBWorldConfigurationError(
    `EVE_FELTDB_PAYLOADS must be "folder", "feltdb-record" or "feltdb-content", not "${backend}"`,
  );
}

/**
 * The factory eve calls (`experimental.workflow.world`), configured from the environment:
 * `EVE_FELTDB_PATH` (required: the directory for FeltDB state, payloads and the queue key),
 * `EVE_FELTDB_PAYLOADS` (`folder`, the default, `feltdb-record` or `feltdb-content`) and
 * `EVE_FELTDB_TRANSACTION_ID_RETENTION_MS` (default 24 hours). It opens FeltDB's Node file
 * runtime exclusively: one process per directory.
 */
export function createWorld(): FeltDBWorld {
  const dataDir = process.env.EVE_FELTDB_PATH;
  if (!dataDir) {
    throw new FeltDBWorldConfigurationError(
      "eve's FeltDB World needs EVE_FELTDB_PATH: the directory that holds the World's FeltDB state, payloads and queue key (created if missing).",
    );
  }
  const retention = process.env.EVE_FELTDB_TRANSACTION_ID_RETENTION_MS;
  const retainMs =
    retention === undefined ? DEFAULT_TRANSACTION_ID_RETENTION_MS : Number(retention);
  if (!Number.isInteger(retainMs) || retainMs < 1) {
    throw new FeltDBWorldConfigurationError(
      `EVE_FELTDB_TRANSACTION_ID_RETENTION_MS must be a positive integer of milliseconds, not "${retention}"`,
    );
  }
  const absolute = path.resolve(dataDir);
  const db = createFeltDB({
    path: path.join(absolute, "state"),
    journal: { retainOperations: 1000, retainTransactionIdsMs: retainMs },
  });
  return createFeltDBWorld({
    db,
    dataDir: absolute,
    payloads: payloadsFor(process.env.EVE_FELTDB_PAYLOADS ?? "folder", db, absolute),
    transactionIdRetentionMs: retainMs,
  });
}

import { createHash } from "node:crypto";

/** A versioned memory document, as eve's `MemoryDocumentBackend` reads and writes it. */
export interface FeltDBMemoryDocument {
  readonly content: string;
  readonly version: string;
}

/** The FeltDB surface the memory backend uses: the `@feltdb/core` database handle satisfies it. */
export interface MemoryDatabase {
  collection(name: string): { get(id: string): Promise<unknown> };
  transaction(
    build: (tx: {
      collection(name: string): {
        set(
          id: string,
          value: Record<string, unknown>,
          options: { requireAbsent?: boolean; ifVersion?: number },
        ): unknown;
      };
    }) => void,
  ): Promise<unknown>;
}

/**
 * Raised when a memory document changed between its read and a conditional
 * write. eve recognizes it by `name` and `key` (`MemoryDocumentConflictError.is`).
 */
export class FeltDBMemoryConflictError extends Error {
  override readonly name = "MemoryDocumentConflictError";
  readonly key: string;

  constructor(key: string) {
    super(`Memory document "${key}" changed before it could be updated.`);
    this.key = key;
  }
}

/** The collection that holds eve memory documents. */
export const MEMORY_COLLECTION = "eve_memory";

/**
 * eve's memory document backend on FeltDB, for `fileMemory({ backend })`.
 * One record per memory key (`eve_memory/<sha256(key)>`) holding the key and
 * the document. A create-only write (`expectedVersion: null`) commits only if
 * no record exists; a replacement only if the record is still at
 * `expectedVersion`; otherwise it throws `MemoryDocumentConflictError`. The
 * version is the record's FeltDB version.
 */
export function feltdbMemory(options: { db: MemoryDatabase }): {
  read(input: { key: string; signal?: AbortSignal }): Promise<FeltDBMemoryDocument | null>;
  write(input: {
    key: string;
    content: string;
    expectedVersion: string | null;
    signal?: AbortSignal;
  }): Promise<FeltDBMemoryDocument>;
} {
  const { db } = options;
  const idOf = (key: string) => createHash("sha256").update(key).digest("hex");
  return {
    async read({ key, signal }) {
      signal?.throwIfAborted();
      const record = (await db.collection(MEMORY_COLLECTION).get(idOf(key))) as {
        key?: unknown;
        content?: unknown;
        __version?: unknown;
      } | null;
      if (!record || record.key !== key || typeof record.content !== "string") return null;
      return { content: record.content, version: String(record.__version ?? 1) };
    },
    async write({ key, content, expectedVersion, signal }) {
      signal?.throwIfAborted();
      const expected = expectedVersion === null ? null : Number(expectedVersion);
      if (expected !== null && !Number.isInteger(expected))
        throw new FeltDBMemoryConflictError(key);
      try {
        await db.transaction((tx) => {
          tx.collection(MEMORY_COLLECTION).set(
            idOf(key),
            { key, content },
            expected === null ? { requireAbsent: true } : { ifVersion: expected },
          );
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "PRECONDITION_FAILED" || code === "CONFLICT")
          throw new FeltDBMemoryConflictError(key);
        throw error;
      }
      return { content, version: String(expected === null ? 1 : expected + 1) };
    },
  };
}

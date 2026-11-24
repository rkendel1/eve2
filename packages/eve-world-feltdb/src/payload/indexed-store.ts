import { createHash } from "node:crypto";
import { PayloadIntegrityError, PayloadMissingError } from "./errors.js";
import type {
  PayloadEntry,
  PayloadGuard,
  PayloadRef,
  PayloadStatus,
  PayloadStore,
  PayloadStoreKind,
  PayloadUsage,
  StoredPayload,
} from "./types.js";

/** The FeltDB collection that indexes payloads, one record per digest. */
export const PAYLOAD_INDEX_COLLECTION = "eve_payloads";

/** The FeltDB surface the payload stores use: the `@feltdb/core` database handle satisfies it. */
export interface PayloadDatabase {
  collection(name: string): { get(id: string): Promise<unknown> };
  transaction(build: (tx: PayloadTransaction) => void | Promise<void>): Promise<unknown>;
  query(request: { collection: string; limit: number; cursor?: string }): Promise<{
    records: unknown[];
    nextCursor?: string;
    exhausted: boolean;
  }>;
  storeContent?(content: Uint8Array): Promise<{ hash: string; bytes: number }>;
  acquireContent?(hash: string): Promise<Uint8Array | null>;
  releaseContent?(hash: string): Promise<{ references: number; deleted: boolean }>;
}

/** The part of a FeltDB transaction scope the payload stores stage writes into. */
export interface PayloadTransaction {
  collection(name: string): {
    set(
      id: string,
      value: Record<string, unknown>,
      options?: { requireAbsent?: boolean; ifVersion?: number },
    ): unknown;
    delete(id: string, options?: { ifVersion?: number }): unknown;
  };
  require(condition: {
    collection: string;
    id: string;
    ifVersion?: number;
    requireAbsent?: boolean;
  }): unknown;
}

/** A payload's FeltDB index record. */
export interface PayloadIndexRecord {
  digest: string;
  bytes: number;
  store: PayloadStoreKind;
  writtenAt: number;
  data?: string;
  __version: number;
}

const DIGEST = /^[0-9a-f]{64}$/;
const PAGE = 500;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new TypeError(`not a SHA-256 hex digest: ${digest}`);
}

export function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown; feltdbCode?: unknown } | null)?.code;
  return code === "PRECONDITION_FAILED" || code === "CONFLICT";
}

export abstract class IndexedPayloadStore implements PayloadStore {
  abstract readonly kind: PayloadStoreKind;
  readonly #locks = new Map<string, Promise<unknown>>();
  protected readonly db: PayloadDatabase;
  protected readonly clock: () => number;

  constructor(db: PayloadDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  protected abstract writeBytes(digest: string, bytes: Uint8Array): Promise<void>;
  protected abstract readBytes(
    digest: string,
    record: PayloadIndexRecord,
  ): Promise<Uint8Array | null>;
  protected abstract deleteBytes(digest: string): Promise<void>;
  protected indexData(_bytes: Uint8Array): string | undefined {
    return undefined;
  }

  async write(bytes: Uint8Array): Promise<PayloadRef> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError("a payload is a non-empty Uint8Array");
    }
    const digest = sha256(bytes);
    const ref: PayloadRef = { digest, bytes: bytes.byteLength, store: this.kind };
    await this.#exclusive(digest, async () => {
      if (await this.#index(digest)) return;
      await this.writeBytes(digest, bytes);
      const record: Record<string, unknown> = {
        digest,
        bytes: bytes.byteLength,
        store: this.kind,
        writtenAt: this.clock(),
      };
      const data = this.indexData(bytes);
      if (data) record.data = data;
      try {
        await this.db.transaction((tx) => {
          tx.collection(PAYLOAD_INDEX_COLLECTION).set(digest, record, { requireAbsent: true });
        });
      } catch (error) {
        if (!isPreconditionFailure(error) || !(await this.#index(digest))) throw error;
      }
    });
    return ref;
  }

  async read(ref: PayloadRef): Promise<Uint8Array> {
    assertDigest(ref.digest);
    const record = await this.#index(ref.digest);
    if (!record) throw new PayloadMissingError(ref.digest);
    const bytes = await this.readBytes(ref.digest, record);
    if (!bytes) throw new PayloadMissingError(ref.digest);
    const actual = sha256(bytes);
    if (actual !== ref.digest)
      throw new PayloadIntegrityError(ref.digest, `bytes hash to ${actual}`);
    if (bytes.byteLength !== ref.bytes) {
      throw new PayloadIntegrityError(
        ref.digest,
        `${bytes.byteLength} bytes, reference says ${ref.bytes}`,
      );
    }
    return bytes;
  }

  async verify(ref: PayloadRef): Promise<PayloadStatus> {
    try {
      await this.read(ref);
      return "ok";
    } catch (error) {
      if (error instanceof PayloadMissingError) return "missing";
      if (error instanceof PayloadIntegrityError) return "corrupt";
      throw error;
    }
  }

  async resolve(digest: string): Promise<StoredPayload | null> {
    assertDigest(digest);
    const record = await this.#index(digest);
    return record ? stored(record) : null;
  }

  async guard(ref: PayloadRef): Promise<PayloadGuard> {
    assertDigest(ref.digest);
    const record = await this.#index(ref.digest);
    if (!record) throw new PayloadMissingError(ref.digest);
    return { collection: PAYLOAD_INDEX_COLLECTION, id: ref.digest, ifVersion: record.__version };
  }

  async usage(): Promise<PayloadUsage> {
    let payloads = 0;
    let bytes = 0;
    for await (const entry of this.list()) {
      payloads += 1;
      bytes += entry.ref.bytes;
    }
    return { payloads, bytes };
  }

  async *list(): AsyncIterable<StoredPayload> {
    for await (const record of this.#records()) yield stored(record);
  }

  async *export(): AsyncIterable<PayloadEntry> {
    for await (const record of this.#records()) {
      const ref = stored(record).ref;
      yield { ref, bytes: await this.read(ref) };
    }
  }

  async import(
    entries: AsyncIterable<PayloadEntry> | Iterable<PayloadEntry>,
  ): Promise<PayloadUsage> {
    let payloads = 0;
    let bytes = 0;
    for await (const entry of entries) {
      const actual = sha256(entry.bytes);
      if (actual !== entry.ref.digest || entry.bytes.byteLength !== entry.ref.bytes) {
        throw new PayloadIntegrityError(entry.ref.digest, `imported bytes hash to ${actual}`);
      }
      await this.write(entry.bytes);
      payloads += 1;
      bytes += entry.bytes.byteLength;
    }
    return { payloads, bytes };
  }

  async remove(ref: PayloadRef): Promise<boolean> {
    assertDigest(ref.digest);
    return this.#exclusive(ref.digest, async () => {
      const record = await this.#index(ref.digest);
      if (!record) return false;
      await this.db.transaction((tx) => {
        tx.collection(PAYLOAD_INDEX_COLLECTION).delete(ref.digest, { ifVersion: record.__version });
      });
      await this.deleteBytes(ref.digest);
      return true;
    });
  }

  async #index(digest: string): Promise<PayloadIndexRecord | null> {
    const record = (await this.db.collection(PAYLOAD_INDEX_COLLECTION).get(digest)) as
      | PayloadIndexRecord
      | null
      | undefined;
    return record ?? null;
  }

  async *#records(): AsyncIterable<PayloadIndexRecord> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.query({
        collection: PAYLOAD_INDEX_COLLECTION,
        limit: PAGE,
        cursor,
      });
      for (const record of page.records) yield record as PayloadIndexRecord;
      if (page.exhausted || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  async #exclusive<T>(digest: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(digest) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    this.#locks.set(digest, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(digest) === settled) this.#locks.delete(digest);
    }
  }
}

function stored(record: PayloadIndexRecord): StoredPayload {
  return {
    ref: { digest: record.digest, bytes: record.bytes, store: record.store },
    writtenAt: record.writtenAt,
  };
}

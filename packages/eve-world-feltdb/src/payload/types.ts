/** Which backend holds a payload's bytes. */
export type PayloadStoreKind = "feltdb-record" | "feltdb-content" | "folder";

/**
 * A durable, verifiable reference to payload bytes: what an authoritative
 * record stores in place of the bytes. The digest is the SHA-256 of the bytes,
 * lowercase hex; every read is checked against it.
 */
export interface PayloadRef {
  readonly digest: string;
  readonly bytes: number;
  readonly store: PayloadStoreKind;
}

/** A payload the store holds, as its FeltDB index record describes it. */
export interface StoredPayload {
  readonly ref: PayloadRef;
  /** When the payload was first written, epoch milliseconds. */
  readonly writtenAt: number;
}

/** What `verify` found. */
export type PayloadStatus = "ok" | "missing" | "corrupt";

/**
 * A FeltDB precondition that holds only while the payload's index record is
 * the one that was verified. Put it in the transaction that commits a record
 * referencing the payload: the commit then fails if the payload was reclaimed
 * in between, instead of committing a reference to missing bytes.
 */
export interface PayloadGuard {
  readonly collection: string;
  readonly id: string;
  readonly ifVersion: number;
}

/** Totals from a store's index. */
export interface PayloadUsage {
  readonly payloads: number;
  readonly bytes: number;
}

/** One payload and its bytes, as `export` yields them and `import` takes them. */
export interface PayloadEntry {
  readonly ref: PayloadRef;
  readonly bytes: Uint8Array;
}

/**
 * Durable payload storage behind eve's FeltDB World.
 *
 * Every implementation keeps one FeltDB index record per payload (collection
 * `eve_payloads`, id = digest), written only after the bytes are durable. A
 * caller commits a record that references a payload only together with the
 * payload's `guard`, so a committed reference always names bytes that were
 * durable when it committed. Bytes are removed only by `remove`, which deletes
 * the index record first.
 *
 * One store instance per process and database: writes and removals of the
 * same digest are serialized in-process.
 */
export interface PayloadStore {
  readonly kind: PayloadStoreKind;
  /** Store bytes durably and index them. Writing bytes already stored returns the existing reference. */
  write(bytes: Uint8Array): Promise<PayloadRef>;
  /** The bytes, verified against the digest. Throws `PayloadMissingError` or `PayloadIntegrityError`. */
  read(ref: PayloadRef): Promise<Uint8Array>;
  /** Whether the payload is indexed and its bytes are present and intact. Never throws for those cases. */
  verify(ref: PayloadRef): Promise<PayloadStatus>;
  /** The index entry for a digest, or `null` when the store does not hold it. */
  resolve(digest: string): Promise<StoredPayload | null>;
  /** The precondition that pins the payload in the referencing commit. Throws `PayloadMissingError` when not indexed. */
  guard(ref: PayloadRef): Promise<PayloadGuard>;
  /** Payload count and bytes, from the index. */
  usage(): Promise<PayloadUsage>;
  /** Every indexed payload, in digest order. */
  list(): AsyncIterable<StoredPayload>;
  /** Every indexed payload with its verified bytes, for archival or backup. Fails on the first missing or corrupt payload. */
  export(): AsyncIterable<PayloadEntry>;
  /** Write exported payloads, each verified against its digest first. Returns what was imported. */
  import(entries: AsyncIterable<PayloadEntry> | Iterable<PayloadEntry>): Promise<PayloadUsage>;
  /** Remove a payload: its index record, then its bytes. `false` when it was not stored. */
  remove(ref: PayloadRef): Promise<boolean>;
}

import {
  IndexedPayloadStore,
  type PayloadDatabase,
  type PayloadIndexRecord,
} from "./indexed-store.js";
import type { PayloadStore } from "./types.js";

class FeltDBRecordPayloads extends IndexedPayloadStore {
  readonly kind = "feltdb-record" as const;

  protected async writeBytes(): Promise<void> {}

  protected override indexData(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }

  protected async readBytes(
    _digest: string,
    record: PayloadIndexRecord,
  ): Promise<Uint8Array | null> {
    return typeof record.data === "string"
      ? new Uint8Array(Buffer.from(record.data, "base64"))
      : null;
  }

  protected async deleteBytes(): Promise<void> {}
}

/**
 * Payloads stored inside their FeltDB index records (base64). The reference
 * implementation: bytes and index commit in one transaction, using only stable
 * FeltDB APIs. Every byte is held in FeltDB's memory, like any other record.
 */
export function feltdbRecordPayloads(options: {
  db: PayloadDatabase;
  clock?: () => number;
}): PayloadStore {
  return new FeltDBRecordPayloads(options.db, options.clock);
}

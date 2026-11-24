import { PayloadIntegrityError } from "./errors.js";
import { IndexedPayloadStore, type PayloadDatabase } from "./indexed-store.js";
import type { PayloadStore } from "./types.js";

class FeltDBContentPayloads extends IndexedPayloadStore {
  readonly kind = "feltdb-content" as const;

  protected async writeBytes(digest: string, bytes: Uint8Array): Promise<void> {
    const stored = await this.db.storeContent!(bytes);
    if (stored.hash !== digest)
      throw new PayloadIntegrityError(digest, `the content store addressed it as ${stored.hash}`);
  }

  protected async readBytes(digest: string): Promise<Uint8Array | null> {
    try {
      return await this.db.acquireContent!(digest);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "CONTENT_INTEGRITY_FAILURE")
        return corrupt(digest);
      throw error;
    }
  }

  protected async deleteBytes(digest: string): Promise<void> {
    for (;;) {
      try {
        const released = await this.db.releaseContent!(digest);
        if (released.deleted) return;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "NOT_FOUND") return;
        throw error;
      }
    }
  }
}

function corrupt(digest: string): never {
  throw new PayloadIntegrityError(
    digest,
    "the content store refused bytes that no longer match their address",
  );
}

/**
 * Payloads in FeltDB's content store (`storeContent`, `acquireContent`,
 * `releaseContent`; Experimental, Node file runtime only), indexed by FeltDB
 * records. A candidate backend under evaluation, not a correctness
 * dependency. It assumes eve is the only user of the database's content store:
 * `remove` releases every reference to the bytes.
 */
export function feltdbContentPayloads(options: {
  db: PayloadDatabase;
  clock?: () => number;
}): PayloadStore {
  const { db } = options;
  if (
    typeof db.storeContent !== "function" ||
    typeof db.acquireContent !== "function" ||
    typeof db.releaseContent !== "function"
  ) {
    throw new TypeError(
      "feltdbContentPayloads needs a FeltDB runtime with a content store (the Node file runtime)",
    );
  }
  return new FeltDBContentPayloads(db, options.clock);
}

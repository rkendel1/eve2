import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { IndexedPayloadStore, assertDigest, type PayloadDatabase } from "./indexed-store.js";
import type { PayloadStore } from "./types.js";

class FolderPayloads extends IndexedPayloadStore {
  readonly kind = "folder" as const;
  readonly root: string;

  constructor(db: PayloadDatabase, root: string, clock?: () => number) {
    super(db, clock);
    this.root = root;
  }

  protected async writeBytes(digest: string, bytes: Uint8Array): Promise<void> {
    const directory = join(this.root, digest.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await syncDirectory(this.root);
    const temporary = join(
      directory,
      `.${digest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(directory, digest));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await syncDirectory(directory);
  }

  protected async readBytes(digest: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#path(digest)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  protected async deleteBytes(digest: string): Promise<void> {
    try {
      await unlink(this.#path(digest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await syncDirectory(join(this.root, digest.slice(0, 2)));
  }

  async unindexed(): Promise<string[]> {
    const digests: string[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return digests;
      throw error;
    }
    for (const shard of shards) {
      for (const name of await readdir(join(this.root, shard))) {
        if (/^[0-9a-f]{64}$/.test(name) && !(await this.resolve(name))) digests.push(name);
      }
    }
    return digests;
  }

  async removeUnindexed(digest: string): Promise<void> {
    assertDigest(digest);
    if (await this.resolve(digest)) throw new Error(`payload ${digest} is indexed; use remove()`);
    await this.deleteBytes(digest);
  }

  #path(digest: string): string {
    return join(this.root, digest.slice(0, 2), digest);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A payload store whose bytes live in a directory eve owns. */
export interface FolderPayloadStore extends PayloadStore {
  readonly root: string;
  /** Digests whose bytes are in the folder but not indexed: left by a crash between writing bytes and indexing them. */
  unindexed(): Promise<string[]>;
  /** Delete the bytes of a digest that is not indexed. */
  removeUnindexed(digest: string): Promise<void>;
}

/**
 * Payloads as files in a directory eve owns (`<root>/<2 hex>/<digest>`, each
 * written to a temporary file, fsynced, renamed and its directory fsynced),
 * indexed by FeltDB records. The fallback that depends on no Experimental
 * FeltDB API; the folder is a second store whose consistency the index
 * defines.
 */
export function folderPayloads(options: {
  db: PayloadDatabase;
  root: string;
  clock?: () => number;
}): FolderPayloadStore {
  return new FolderPayloads(options.db, options.root, options.clock);
}

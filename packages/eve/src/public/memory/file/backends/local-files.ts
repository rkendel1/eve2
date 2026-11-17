import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MemoryDocumentConflictError,
  type MemoryDocument,
  type MemoryDocumentBackend,
} from "#public/memory/file/backend.js";

/** Directory configuration for {@link localFiles}. */
export interface LocalFilesBackendOptions {
  /**
   * Directory that stores one file per memory scope key. Relative paths
   * resolve from the server's working directory. Defaults to `.eve/memory`.
   */
  readonly directory?: string;
}

/**
 * Creates a document backend that stores memory files on the local disk.
 * Writes are atomic and compare-and-set within one server process, so use it
 * with one `eve start` process per directory, on a persistent volume.
 */
export function localFiles(options: LocalFilesBackendOptions = {}): MemoryDocumentBackend {
  const directory = resolve(options.directory ?? join(".eve", "memory"));
  const pending = new Map<string, Promise<unknown>>();

  const pathFor = (key: string) =>
    join(directory, `${createHash("sha256").update(key).digest("hex")}.md`);

  const readDocument = async (key: string): Promise<MemoryDocument | null> => {
    let content: string;
    try {
      content = await readFile(pathFor(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return { content, version: versionOf(content) };
  };

  const serialized = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = pending.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    pending.set(key, settled);
    void settled.then(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
    return next;
  };

  return {
    async read({ key, signal }) {
      signal.throwIfAborted();
      return await readDocument(key);
    },
    async write({ content, expectedVersion, key, signal }) {
      signal.throwIfAborted();
      return await serialized(key, async () => {
        const current = await readDocument(key);
        if ((current?.version ?? null) !== expectedVersion) {
          throw new MemoryDocumentConflictError(key);
        }
        signal.throwIfAborted();
        const path = pathFor(key);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true });
        try {
          await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, path);
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
        return { content, version: versionOf(content) };
      });
    },
  };
}

function versionOf(content: string): string {
  return `sha256_${createHash("sha256").update(content).digest("hex")}`;
}

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryDocumentConflictError } from "#public/memory/file/backend.js";

import { localFiles } from "./local-files.js";

const signal = new AbortController().signal;

async function directory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-local-files-"));
}

describe("localFiles", () => {
  it("creates, reads, and conditionally replaces a document", async () => {
    const backend = localFiles({ directory: await directory() });

    await expect(backend.read({ key: "alice", signal })).resolves.toBeNull();
    const created = await backend.write({
      content: "Alice prefers tea.\n",
      expectedVersion: null,
      key: "alice",
      signal,
    });
    await expect(backend.read({ key: "alice", signal })).resolves.toEqual(created);

    const updated = await backend.write({
      content: "Alice prefers green tea.\n",
      expectedVersion: created.version,
      key: "alice",
      signal,
    });
    expect(updated.version).not.toBe(created.version);
    await expect(backend.read({ key: "alice", signal })).resolves.toEqual(updated);
  });

  it("rejects create-only and stale writes with a conflict", async () => {
    const backend = localFiles({ directory: await directory() });
    const created = await backend.write({
      content: "v1",
      expectedVersion: null,
      key: "bob",
      signal,
    });
    await backend.write({ content: "v2", expectedVersion: created.version, key: "bob", signal });

    await expect(
      backend.write({ content: "again", expectedVersion: null, key: "bob", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
    await expect(
      backend.write({ content: "stale", expectedVersion: created.version, key: "bob", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
    await expect(backend.read({ key: "bob", signal })).resolves.toMatchObject({ content: "v2" });
  });

  it("lets exactly one of two concurrent writes from the same version win", async () => {
    const backend = localFiles({ directory: await directory() });
    const base = await backend.write({ content: "base", expectedVersion: null, key: "k", signal });

    const results = await Promise.allSettled([
      backend.write({ content: "from Alice", expectedVersion: base.version, key: "k", signal }),
      backend.write({ content: "from Bob", expectedVersion: base.version, key: "k", signal }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(MemoryDocumentConflictError.is(rejected?.reason)).toBe(true);
  });

  it("keeps documents across backend instances and leaves no temporary files", async () => {
    const root = await directory();
    await localFiles({ directory: root }).write({
      content: "Remember the PELICAN-42 codeword.\n",
      expectedVersion: null,
      key: "scope:alice/notes",
      signal,
    });

    await expect(
      localFiles({ directory: root }).read({ key: "scope:alice/notes", signal }),
    ).resolves.toMatchObject({ content: "Remember the PELICAN-42 codeword.\n" });
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.md$/u);
  });

  it("honors an aborted signal before writing", async () => {
    const root = await directory();
    const controller = new AbortController();
    controller.abort();

    await expect(
      localFiles({ directory: root }).write({
        content: "x",
        expectedVersion: null,
        key: "k",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(readdir(root)).resolves.toEqual([]);
  });
});

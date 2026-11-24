import { createFeltDB } from "@feltdb/core";
import { describe, expect, it } from "vitest";
import { FeltDBMemoryConflictError, feltdbMemory } from "./feltdb-memory.js";

const memory = () =>
  feltdbMemory({ db: createFeltDB({ memory: true, namespace: `memory-${crypto.randomUUID()}` }) });

describe("feltdbMemory", () => {
  it("returns null for a key never written, then creates it once", async () => {
    const backend = memory();
    expect(await backend.read({ key: "scope:alice" })).toBeNull();
    const created = await backend.write({
      key: "scope:alice",
      content: "likes tea",
      expectedVersion: null,
    });
    expect(await backend.read({ key: "scope:alice" })).toEqual(created);
    await expect(
      backend.write({ key: "scope:alice", content: "again", expectedVersion: null }),
    ).rejects.toBeInstanceOf(FeltDBMemoryConflictError);
  });

  it("replaces only at the version it read, and reports the new version", async () => {
    const backend = memory();
    const first = await backend.write({ key: "k", content: "v1", expectedVersion: null });
    const second = await backend.write({ key: "k", content: "v2", expectedVersion: first.version });
    expect(await backend.read({ key: "k" })).toEqual(second);
    await expect(
      backend.write({ key: "k", content: "v3", expectedVersion: first.version }),
    ).rejects.toMatchObject({
      name: "MemoryDocumentConflictError",
      key: "k",
    });
    expect((await backend.read({ key: "k" }))?.content).toBe("v2");
  });

  it("lets exactly one of two concurrent writers at one version win", async () => {
    const backend = memory();
    const base = await backend.write({ key: "k", content: "v1", expectedVersion: null });
    const results = await Promise.allSettled([
      backend.write({ key: "k", content: "from a", expectedVersion: base.version }),
      backend.write({ key: "k", content: "from b", expectedVersion: base.version }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("keeps keys apart, including keys that are not FeltDB ids", async () => {
    const backend = memory();
    await backend.write({ key: "agent/alice memory.md", content: "a", expectedVersion: null });
    await backend.write({ key: "agent/bob memory.md", content: "b", expectedVersion: null });
    expect((await backend.read({ key: "agent/alice memory.md" }))?.content).toBe("a");
    expect((await backend.read({ key: "agent/bob memory.md" }))?.content).toBe("b");
  });
});

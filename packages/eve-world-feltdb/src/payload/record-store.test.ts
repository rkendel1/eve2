import { createFeltDB } from "@feltdb/core";
import { describe, expect, it } from "vitest";
import {
  PayloadIntegrityError,
  PayloadMissingError,
  feltdbRecordPayloads,
  findOrphanedPayloads,
} from "../index.js";

const bytesOf = (text: string) => new TextEncoder().encode(text);

function memoryStore(clock?: () => number) {
  const db = createFeltDB({ memory: true, namespace: `payloads-${crypto.randomUUID()}`, clock });
  return { db, store: feltdbRecordPayloads({ db, clock }) };
}

describe("feltdbRecordPayloads on the memory runtime", () => {
  it("round-trips bytes and stores a repeated payload once", async () => {
    const { store } = memoryStore();
    const ref = await store.write(bytesOf("alpha"));
    expect(await store.write(bytesOf("alpha"))).toEqual(ref);
    expect(ref).toEqual({
      digest: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
      bytes: 5,
      store: "feltdb-record",
    });
    expect(new TextDecoder().decode(await store.read(ref))).toBe("alpha");
    expect(await store.usage()).toEqual({ payloads: 1, bytes: 5 });
  });

  it("refuses empty payloads and references that are not SHA-256 digests", async () => {
    const { store } = memoryStore();
    await expect(store.write(new Uint8Array())).rejects.toThrow(TypeError);
    await expect(store.read({ digest: "nope", bytes: 1, store: "feltdb-record" })).rejects.toThrow(
      TypeError,
    );
  });

  it("refuses a reference whose size does not match the stored bytes", async () => {
    const { store } = memoryStore();
    const ref = await store.write(bytesOf("sized"));
    await expect(store.read({ ...ref, bytes: 6 })).rejects.toBeInstanceOf(PayloadIntegrityError);
  });

  it("guards the referencing commit and reports removed payloads as missing", async () => {
    const { db, store } = memoryStore();
    const ref = await store.write(bytesOf("pinned"));
    const guard = await store.guard(ref);
    await store.remove(ref);
    await expect(
      db.transaction((tx) => {
        tx.require(guard);
        tx.collection("events").set("e1", { ref: { ...ref } });
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(store.read(ref)).rejects.toBeInstanceOf(PayloadMissingError);
    expect(await store.verify(ref)).toBe("missing");
  });

  it("serializes concurrent writes and removals of one digest", async () => {
    const { store } = memoryStore();
    const refs = await Promise.all(Array.from({ length: 8 }, () => store.write(bytesOf("same"))));
    expect(new Set(refs.map((ref) => ref.digest)).size).toBe(1);
    const removals = await Promise.all([store.remove(refs[0]!), store.remove(refs[0]!)]);
    expect(removals.sort()).toEqual([false, true]);
  });

  it("finds unreferenced payloads only past the grace period", async () => {
    const clock = { t: 10_000 };
    const { store } = memoryStore(() => clock.t);
    const old = await store.write(bytesOf("old"));
    clock.t += 5_000;
    await store.write(bytesOf("new"));
    const orphans = await findOrphanedPayloads(store, () => false, {
      graceMs: 1_000,
      now: clock.t,
    });
    expect(orphans.map((orphan) => orphan.ref)).toEqual([old]);
  });
});

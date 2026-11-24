import { createFeltDB } from "@feltdb/core";
import { describe, expect, it } from "vitest";
import { feltdbRecordPayloads } from "../payload/record-store.js";
import {
  COLLECTIONS,
  CommitThenThrow,
  WorldDatabase,
  WorldTransactionAborted,
  joinKey,
  keyPart,
} from "./database.js";

function world(inlineDocBytes = 1024) {
  const db = createFeltDB({ memory: true, namespace: `world-db-${crypto.randomUUID()}` });
  return {
    db,
    database: new WorldDatabase({ db, payloads: feltdbRecordPayloads({ db }), inlineDocBytes }),
  };
}

describe("WorldDatabase unit of work", () => {
  it("sees its own staged writes and commits them as one transaction", async () => {
    const { database } = world();
    await database.transact(async (unit) => {
      unit.set(COLLECTIONS.runs, "r1", { runId: "r1", seq: 0 });
      expect(await unit.get(COLLECTIONS.runs, "r1")).toMatchObject({ runId: "r1", seq: 0 });
      unit.set(COLLECTIONS.runs, "r1", { runId: "r1", seq: 1 });
    });
    expect(await database.read(COLLECTIONS.runs, "r1")).toMatchObject({ runId: "r1", seq: 1 });
  });

  it("commits nothing when the body throws", async () => {
    const { database } = world();
    await expect(
      database.transact(async (unit) => {
        unit.set(COLLECTIONS.runs, "r1", { runId: "r1" });
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await database.read(COLLECTIONS.runs, "r1")).toBeNull();
  });

  it("commits what it staged, then throws, when the body returns CommitThenThrow", async () => {
    const { database } = world();
    await expect(
      database.transact(async (unit) => {
        unit.set(COLLECTIONS.startHookRejections, "r1", { runId: "r1", token: "t" });
        return new CommitThenThrow(new Error("conflict recorded"));
      }),
    ).rejects.toThrow("conflict recorded");
    expect(await database.read(COLLECTIONS.startHookRejections, "r1")).toMatchObject({
      token: "t",
    });
  });

  it("refuses the whole commit when a record it read changed underneath it", async () => {
    const { db, database } = world();
    await db.transaction((tx) => {
      tx.collection(COLLECTIONS.runs).set("r1", { runId: "r1", seq: 0 });
    });
    await expect(
      database.transact(async (unit) => {
        await unit.get(COLLECTIONS.runs, "r1");
        await db.transaction((tx) => {
          tx.collection(COLLECTIONS.runs).set("r1", { runId: "r1", seq: 5 }, { ifVersion: 1 });
        });
        unit.set(COLLECTIONS.events, joinKey("r1", 1), { runId: "r1", seq: 1 });
      }),
    ).rejects.toBeInstanceOf(WorldTransactionAborted);
    expect(await database.read(COLLECTIONS.events, joinKey("r1", 1))).toBeNull();
  });

  it("refuses to create a record that appeared after it was read as absent", async () => {
    const { db, database } = world();
    await expect(
      database.transact(async (unit) => {
        expect(await unit.get(COLLECTIONS.hookTokens, "tok")).toBeNull();
        await db.transaction((tx) => {
          tx.collection(COLLECTIONS.hookTokens).set("tok", { token: "tok", runId: "other" });
        });
        unit.set(COLLECTIONS.hookTokens, "tok", { token: "tok", runId: "mine" });
      }),
    ).rejects.toBeInstanceOf(WorldTransactionAborted);
    expect(await database.read(COLLECTIONS.hookTokens, "tok")).toMatchObject({ runId: "other" });
  });

  it("serializes units in the process", async () => {
    const { database } = world();
    await database.transact(async (unit) =>
      unit.set(COLLECTIONS.runs, "r1", { runId: "r1", seq: 0 }),
    );
    await Promise.all(
      Array.from({ length: 20 }, () =>
        database.transact(async (unit) => {
          const head = await unit.get(COLLECTIONS.runs, "r1");
          unit.set(COLLECTIONS.runs, "r1", { ...head, seq: Number(head?.seq) + 1 });
        }),
      ),
    );
    expect(await database.read(COLLECTIONS.runs, "r1")).toMatchObject({ seq: 20 });
  });

  it("stores a large document through the payload store and reads it back", async () => {
    const { database } = world(64);
    const big = "x".repeat(500);
    await database.transact(async (unit) =>
      unit.set(COLLECTIONS.runs, "r1", { runId: "r1", doc: big }),
    );
    const record = await database.read(COLLECTIONS.runs, "r1");
    expect(record?.doc).toBeUndefined();
    expect(record?.docRef).toMatchObject({ bytes: 500, store: "feltdb-record" });
    expect(await database.internalize(record!, "doc")).toBe(big);
  });

  it("keeps plain ids and hashes the rest into FeltDB-safe keys", () => {
    expect(keyPart("wrun_01JABC")).toBe("wrun_01JABC");
    expect(keyPart("a token with spaces")).toMatch(/^x[0-9a-f]{64}$/);
    expect(joinKey("wrun_1", 7)).toBe("wrun_1.000000000007");
  });
});

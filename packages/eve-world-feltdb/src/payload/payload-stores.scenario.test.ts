import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFeltDB } from "@feltdb/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  PayloadIntegrityError,
  PayloadMissingError,
  feltdbContentPayloads,
  feltdbRecordPayloads,
  findOrphanedPayloads,
  folderPayloads,
  type PayloadDatabase,
  type PayloadRef,
  type PayloadStore,
} from "../index.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const databases: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close().catch(() => undefined);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "eve-payloads-"));
  directories.push(dir);
  return dir;
}

function openDb(path: string, clock?: () => number) {
  const db = createFeltDB({ path, clock });
  databases.push(db);
  return db;
}

type Backend = "feltdb-record" | "feltdb-content" | "folder";
const BACKENDS: Backend[] = ["feltdb-record", "feltdb-content", "folder"];

function storeFor(
  backend: Backend,
  dir: string,
  db: PayloadDatabase,
  clock?: () => number,
): PayloadStore {
  if (backend === "feltdb-record") return feltdbRecordPayloads({ db, clock });
  if (backend === "feltdb-content") return feltdbContentPayloads({ db, clock });
  return folderPayloads({ db, root: join(dir, "payloads"), clock });
}

function open(backend: Backend, dir = scratch(), clock?: () => number) {
  const db = openDb(join(dir, "state"), clock);
  return { dir, db, store: storeFor(backend, dir, db, clock) };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

async function commitEvent(
  db: PayloadDatabase,
  store: PayloadStore,
  id: string,
  ref: PayloadRef,
): Promise<void> {
  const guard = await store.guard(ref);
  await db.transaction((tx) => {
    tx.require(guard);
    tx.collection("test_events").set(id, { ref: { ...ref } }, { requireAbsent: true });
  });
}

function bytesFile(backend: Backend, dir: string, digest: string): string | undefined {
  if (backend === "feltdb-content") return join(dir, "state", "content", digest);
  if (backend === "folder") return join(dir, "payloads", digest.slice(0, 2), digest);
  return undefined;
}

describe.each(BACKENDS)("%s payload store", (backend) => {
  it("writes durably, reads verified bytes, and deduplicates repeated payloads", async () => {
    const { store } = open(backend);
    const first = await store.write(bytesOf("hello, payload"));
    const again = await store.write(bytesOf("hello, payload"));
    expect(again).toEqual(first);
    expect(first.store).toBe(backend);
    expect(new TextDecoder().decode(await store.read(first))).toBe("hello, payload");
    expect(await store.usage()).toEqual({ payloads: 1, bytes: 14 });
    expect(await store.resolve(first.digest)).toMatchObject({ ref: first });
  });

  it("reports a missing payload, and never returns corrupted bytes", async () => {
    const { dir, db, store } = open(backend);
    const ref = await store.write(bytesOf("will be damaged"));
    const file = bytesFile(backend, dir, ref.digest);
    if (file) {
      writeFileSync(file, "tampered");
    } else {
      const record = (await db.collection("eve_payloads").get(ref.digest)) as Record<
        string,
        unknown
      >;
      await db.transaction((tx) => {
        tx.collection("eve_payloads").set(ref.digest, {
          ...record,
          data: Buffer.from("tampered").toString("base64"),
        });
      });
    }
    expect(await store.verify(ref)).toBe("corrupt");
    await expect(store.read(ref)).rejects.toBeInstanceOf(PayloadIntegrityError);

    const gone = await store.write(bytesOf("will be lost"));
    const goneFile = bytesFile(backend, dir, gone.digest);
    if (goneFile) rmSync(goneFile);
    else
      await db.transaction((tx) => {
        tx.collection("eve_payloads").delete(gone.digest);
      });
    expect(await store.verify(gone)).toBe("missing");
    await expect(store.read(gone)).rejects.toBeInstanceOf(PayloadMissingError);
  });

  it("pins a payload in the referencing commit: a reclaimed payload cannot be referenced", async () => {
    const { db, store } = open(backend);
    const ref = await store.write(bytesOf("referenced"));
    const staleGuard = await store.guard(ref);
    await commitEvent(db, store, "e1", ref);
    expect(await store.remove(ref)).toBe(true);
    await expect(
      db.transaction((tx) => {
        tx.require(staleGuard);
        tx.collection("test_events").set("e2", { ref: { ...ref } }, { requireAbsent: true });
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(store.guard(ref)).rejects.toBeInstanceOf(PayloadMissingError);
    expect(await store.verify(ref)).toBe("missing");
    expect(await store.remove(ref)).toBe(false);

    const rewritten = await store.write(bytesOf("referenced"));
    await commitEvent(db, store, "e2", rewritten);
    expect(await store.verify(rewritten)).toBe("ok");
  });

  it("finds orphans by reference and age, sparing payloads still referenced or inside the grace period", async () => {
    const clock = { t: 1_000_000 };
    const { db, store } = open(backend, scratch(), () => clock.t);
    const shared = await store.write(bytesOf("shared by two events"));
    await commitEvent(db, store, "a", shared);
    await commitEvent(db, store, "b", shared);
    const abandoned = await store.write(bytesOf("written, never referenced"));
    clock.t += 60_000;
    const fresh = await store.write(bytesOf("written a moment ago"));
    const referenced = new Set([shared.digest]);
    const orphans = await findOrphanedPayloads(store, (digest) => referenced.has(digest), {
      graceMs: 30_000,
      now: clock.t,
    });
    expect(orphans.map((o) => o.ref.digest)).toEqual([abandoned.digest]);
    expect(orphans.some((o) => o.ref.digest === fresh.digest)).toBe(false);
  });

  it("exports verified payloads and restores them into a fresh store", async () => {
    const source = open(backend);
    const refs = [];
    for (let i = 0; i < 25; i += 1)
      refs.push(await source.store.write(bytesOf(`payload ${i} `.repeat(i + 1))));
    const exported = [];
    for await (const entry of source.store.export()) exported.push(entry);
    expect(exported).toHaveLength(25);

    const target = open(backend);
    expect(await target.store.import(exported)).toEqual(await source.store.usage());
    for (const ref of refs) expect(await target.store.verify(ref)).toBe("ok");
    await expect(
      target.store.import([{ ref: refs[0]!, bytes: bytesOf("not these bytes") }]),
    ).rejects.toBeInstanceOf(PayloadIntegrityError);
  });

  it("survives restart, compaction and a copy of the stopped directories", async () => {
    const { dir, db, store } = open(backend);
    const refs = [];
    for (let i = 0; i < 40; i += 1) {
      const ref = await store.write(bytesOf(`turn ${i} output`));
      await commitEvent(db, store, `e${i}`, ref);
      refs.push(ref);
    }
    await db.compact();
    await db.close();

    const copy = scratch();
    cpSync(dir, copy, { recursive: true });
    for (const where of [dir, copy]) {
      const reopened = open(backend, where);
      for (const ref of refs) expect(await reopened.store.verify(ref)).toBe("ok");
      expect((await reopened.store.usage()).payloads).toBe(40);
      await reopened.db.close();
    }
  });
});

const childScript = (backend: Backend) => `
import { createFeltDB } from "@feltdb/core";
import { feltdbContentPayloads, feltdbRecordPayloads, folderPayloads } from ${JSON.stringify(join(packageRoot, "dist/index.js"))};
const dir = process.argv[2];
const db = createFeltDB({ path: dir + "/state" });
const store = ${JSON.stringify(backend)} === "feltdb-record" ? feltdbRecordPayloads({ db })
  : ${JSON.stringify(backend)} === "feltdb-content" ? feltdbContentPayloads({ db })
  : folderPayloads({ db, root: dir + "/payloads" });
const start = Number(process.argv[3]);
for (let i = start; ; i += 1) {
  const ref = await store.write(new TextEncoder().encode("event " + i + " " + "x".repeat(i % 4000)));
  const guard = await store.guard(ref);
  await db.transaction((tx) => { tx.require(guard); tx.collection("test_events").set("e" + i, { ref: { ...ref } }, { requireAbsent: true }); });
  console.log("ack " + i);
  if (i % 25 === 0) await db.compact();
}
`;

function runUntilKilled(file: string, dir: string, start: number, acks: number): Promise<number> {
  return new Promise((resolveAcked) => {
    const child = spawn(process.execPath, [file, dir, String(start)], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let last = start - 1;
    let target = start + acks;
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split("\n")) {
        const match = /^ack (\d+)$/.exec(line);
        if (match) last = Number(match[1]);
      }
      if (last >= target) {
        target = Number.POSITIVE_INFINITY;
        child.kill("SIGKILL");
      }
    });
    child.once("close", () => resolveAcked(last));
  });
}

describe.each(BACKENDS)("%s payload store under SIGKILL", (backend) => {
  it("never commits a reference to a payload that is not durable, across repeated kills", async () => {
    const dir = scratch();
    const file = join(packageRoot, `.kill-child-${backend}-${process.pid}.mjs`);
    writeFileSync(file, childScript(backend));
    directories.push(file);
    let next = 0;
    let acknowledged = 0;
    for (let round = 0; round < 4; round += 1) {
      const last = await runUntilKilled(file, dir, next, 30 + round * 7);
      acknowledged += last - next + 1;
      next = last + 2;
    }

    const { db, store } = open(backend, dir);
    const events = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await db.query({
        collection: "test_events",
        limit: 500,
        cursor,
      });
      events.push(...(page.records as Array<{ ref: PayloadRef }>));
      if (page.exhausted || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(events.length).toBeGreaterThanOrEqual(acknowledged);
    for (const event of events) expect(await store.verify(event.ref)).toBe("ok");

    const referenced = new Set(events.map((event) => event.ref.digest));
    const orphans = await findOrphanedPayloads(store, (digest) => referenced.has(digest), {
      graceMs: 0,
    });
    expect(orphans.length).toBeLessThanOrEqual(4);
    for (const orphan of orphans) expect(await store.remove(orphan.ref)).toBe(true);
    if (backend === "folder") {
      const folder = store as ReturnType<typeof folderPayloads>;
      const unindexed = await folder.unindexed();
      expect(unindexed.length).toBeLessThanOrEqual(4);
      for (const digest of unindexed) await folder.removeUnindexed(digest);
      const files = readdirSync(join(dir, "payloads"), { recursive: true }).filter((name) =>
        /[0-9a-f]{64}$/.test(String(name)),
      );
      expect(files).toHaveLength(referenced.size);
    }
    expect((await store.usage()).payloads).toBe(referenced.size);
  });
});

import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const { createFeltDB } = await import(process.env.FELTDB_CORE ?? "@feltdb/core");
const { feltdbContentPayloads, feltdbRecordPayloads, folderPayloads } =
  await import("../dist/index.js");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const backend = option("backend", "folder");
const turns = Number(option("turns", 5000));
const archive = args.includes("--archive");
const retainIdsMs = args.includes("--retain-ids-forever")
  ? undefined
  : Number(option("retain-ids-ms", 600_000));
const samples = Number(option("samples", 10));
if (!globalThis.gc) throw new Error("run with node --expose-gc");

const root = mkdtempSync(join(tmpdir(), "eve-capacity-"));
const clock = { t: 1_700_000_000_000 };
const open = () =>
  createFeltDB({
    path: join(root, "state"),
    clock: () => clock.t,
    journal: {
      retainOperations: 1000,
      ...(retainIdsMs ? { retainTransactionIdsMs: retainIdsMs } : {}),
    },
  });
const storeFor = (db) =>
  backend === "feltdb-record"
    ? feltdbRecordPayloads({ db, clock: () => clock.t })
    : backend === "feltdb-content"
      ? feltdbContentPayloads({ db, clock: () => clock.t })
      : folderPayloads({ db, root: join(root, "payloads"), clock: () => clock.t });

const bytesUnder = (path) => {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
};
const directoryMb = (name) => {
  try {
    return +(bytesUnder(join(root, name)) / 1e6).toFixed(2);
  } catch {
    return 0;
  }
};
const memory = () => {
  globalThis.gc();
  const usage = process.memoryUsage();
  return { heapMb: +(usage.heapUsed / 1e6).toFixed(1), rssMb: +(usage.rss / 1e6).toFixed(1) };
};

let db = open();
let store = storeFor(db);
let commits = 0;
const commitLatency = [];
async function commit(build) {
  const started = performance.now();
  await db.transaction(build);
  commitLatency.push(performance.now() - started);
  commits += 1;
}
async function writePayload(size) {
  const before = commits;
  const ref = await store.write(randomBytes(size));
  commits = before + (backend === "feltdb-content" ? 2 : 1);
  return ref;
}

const sessions = [];
async function runTurn(turn) {
  const sessionIndex = Math.floor(turn / 10);
  const runId = `wrun_${sessionIndex}`;
  if (turn % 10 === 0) {
    sessions.push({ runId, events: [], chunks: [], payloads: [] });
    await commit((tx) =>
      tx.collection("wf_runs").set(runId, { status: "running", seq: 0 }, { requireAbsent: true }),
    );
  }
  const session = sessions.at(-1);
  for (let step = 0; step < 2; step += 1) {
    const messageId = `msg_${turn}_${step}`;
    await commit((tx) =>
      tx
        .collection("wf_messages")
        .set(messageId, { runId, state: "ready" }, { requireAbsent: true }),
    );
    await commit((tx) =>
      tx.collection("wf_messages").set(messageId, { runId, state: "leased" }, { ifVersion: 1 }),
    );
    await commit((tx) => tx.collection("wf_messages").delete(messageId, { ifVersion: 2 }));
  }
  for (let event = 0; event < 7; event += 1) {
    const ref = await writePayload(1700 + Math.floor(Math.random() * 400));
    const guard = await store.guard(ref);
    const head = await db.collection("wf_runs").get(runId);
    const id = `${runId}.${String(head.seq + 1).padStart(8, "0")}`;
    await commit((tx) => {
      tx.require(guard);
      tx.collection("wf_runs").set(
        runId,
        { status: "running", seq: head.seq + 1 },
        { ifVersion: head.__version },
      );
      tx.collection("wf_events").set(
        id,
        { runId, type: "step_completed", ref: { ...ref } },
        { requireAbsent: true },
      );
    });
    session.events.push(id);
    session.payloads.push(ref);
  }
  for (let flush = 0; flush < 8; flush += 1) {
    const ref = await writePayload((76 * 210) / 8);
    const guard = await store.guard(ref);
    const id = `${runId}.${String(turn).padStart(8, "0")}.${flush}`;
    await commit((tx) => {
      tx.require(guard);
      tx.collection("wf_chunks").set(id, { ref: { ...ref } }, { requireAbsent: true });
    });
    session.chunks.push(id);
    session.payloads.push(ref);
  }
  if (archive && turn % 10 === 9 && sessions.length > 20) {
    const old = sessions.shift();
    await commit((tx) => {
      for (const id of old.events) tx.collection("wf_events").delete(id);
      for (const id of old.chunks) tx.collection("wf_chunks").delete(id);
      tx.collection("wf_runs").delete(old.runId);
    });
    for (const ref of old.payloads) await store.remove(ref);
    commits += old.payloads.length * (backend === "feltdb-content" ? 2 : 1);
  }
}

const baseline = memory();
const every = Math.max(1, Math.floor(turns / samples));
const started = performance.now();
for (let turn = 0; turn < turns; turn += 1) {
  clock.t += 2000;
  await runTurn(turn);
  if (turn % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  if ((turn + 1) % every === 0) {
    const journal = await db.journalStatus();
    console.log(
      JSON.stringify({
        turns: turn + 1,
        commits,
        ...memory(),
        feltdbMb: directoryMb("state"),
        payloadsMb: backend === "folder" ? directoryMb("payloads") : directoryMb("state/content"),
        snapshotMb: +(journal.persistence.snapshotBytes / 1e6).toFixed(2),
        idsRetained: journal.transactionIds?.retained,
      }),
    );
  }
}
const writeSeconds = (performance.now() - started) / 1000;
const usage = await store.usage();
await db.close();
db = null;
store = null;
const closed = memory();
const reopenStarted = performance.now();
db = open();
store = storeFor(db);
await db.collection("wf_runs").count();
const reopenMs = performance.now() - reopenStarted;
const reopened = memory();
const journal = await db.journalStatus();
await db.close();
commitLatency.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    summary: true,
    node: process.version,
    backend,
    turns,
    archive,
    retainIdsMs: retainIdsMs ?? null,
    commits,
    commitsPerTurn: +(commits / turns).toFixed(1),
    writeSeconds: +writeSeconds.toFixed(1),
    commitMs: {
      p50: +commitLatency[commitLatency.length >> 1].toFixed(2),
      p99: +commitLatency[Math.floor(commitLatency.length * 0.99)].toFixed(2),
    },
    payloads: usage,
    baseline,
    closed,
    reopenMs: +reopenMs.toFixed(0),
    reopened,
    feltdbMb: directoryMb("state"),
    payloadsMb: backend === "folder" ? directoryMb("payloads") : directoryMb("state/content"),
    snapshotMb: +(journal.persistence.snapshotBytes / 1e6).toFixed(2),
    idsRetained: journal.transactionIds?.retained,
  }),
);
rmSync(root, { recursive: true, force: true });

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const feltdbEntry = resolve(
  process.env.FELTDB_CORE ?? join(here, "../node_modules/@feltdb/core/dist/index.js"),
);
const { createFeltDB } = await import(feltdbEntry);
const { feltdbContentPayloads, feltdbRecordPayloads, folderPayloads } =
  await import("../dist/index.js");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const config = {
  backend: option("backend", "folder"),
  turns: Number(option("turns", 5000)),
  archive: args.includes("--archive"),
  retainIdsMs: args.includes("--retain-ids-forever")
    ? null
    : Number(option("retain-ids-ms", 600_000)),
  retainOperations: 1000,
  sessionTurns: 10,
  archiveAfterSessions: 20,
  storeSecondsPerTurn: 2,
  samples: Number(option("samples", 10)),
};

const git = (cwd, gitArgs) => {
  try {
    return execFileSync("git", gitArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

function treeDigest(root) {
  const hash = createHash("sha256");
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) hash.update(file.slice(root.length)).update(readFileSync(file));
  return { files: files.length, sha256: hash.digest("hex") };
}

function provenance() {
  const feltdbDist = dirname(feltdbEntry);
  const feltdbSource = resolve(feltdbDist, "..");
  const feltdbPackage = JSON.parse(readFileSync(join(feltdbSource, "package.json"), "utf8"));
  const probe = createFeltDB({ memory: true, namespace: `probe-${process.pid}` });
  return {
    feltdb: {
      package: `${feltdbPackage.name}@${feltdbPackage.version}`,
      entry: feltdbEntry,
      commit: git(feltdbSource, ["rev-parse", "HEAD"]),
      dirty: git(feltdbSource, ["status", "--porcelain", "--", "src"]) !== "",
      dist: treeDigest(feltdbDist),
      transactionIdRetention: probe.capabilities().transactionIdRetention === true,
    },
    eve: {
      package: "@appport/eve-world-feltdb",
      commit: git(here, ["rev-parse", "HEAD"]),
      dirty: git(here, ["status", "--porcelain", "--", ".."]) !== "",
    },
    node: process.version,
    machine: {
      cpus: cpus().length,
      model: cpus()[0]?.model,
      memoryGb: +(totalmem() / 1e9).toFixed(1),
    },
    config,
  };
}

function bytesUnder(path) {
  let total = 0;
  try {
    for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
    }
  } catch {
    return 0;
  }
  return total;
}

const mb = (bytes) => +(bytes / 1e6).toFixed(2);
const memory = () => {
  globalThis.gc();
  const usage = process.memoryUsage();
  return { heapMb: +(usage.heapUsed / 1e6).toFixed(1), rssMb: +(usage.rss / 1e6).toFixed(1) };
};
const payloadDir = (root) =>
  config.backend === "folder" ? join(root, "payloads") : join(root, "state", "content");
const disk = (root) => {
  const payloads = config.backend === "feltdb-record" ? 0 : bytesUnder(payloadDir(root));
  const state = bytesUnder(join(root, "state"));
  return {
    feltdbMb: mb(config.backend === "feltdb-content" ? state - payloads : state),
    payloadsMb: mb(payloads),
  };
};

function open(root, clock) {
  const journal = { retainOperations: config.retainOperations };
  if (config.retainIdsMs) journal.retainTransactionIdsMs = config.retainIdsMs;
  const db = createFeltDB({ path: join(root, "state"), clock, journal });
  const store =
    config.backend === "feltdb-record"
      ? feltdbRecordPayloads({ db, clock })
      : config.backend === "feltdb-content"
        ? feltdbContentPayloads({ db, clock })
        : folderPayloads({ db, root: join(root, "payloads"), clock });
  return { db, store };
}

async function allRecords(db, collection) {
  const records = [];
  let cursor;
  for (;;) {
    const page = await db.query({ collection, limit: 1000, cursor });
    records.push(...page.records);
    if (page.exhausted || !page.nextCursor) return records;
    cursor = page.nextCursor;
  }
}

async function workload(root) {
  const clock = { t: 1_700_000_000_000 };
  const { db, store } = open(root, () => clock.t);
  let commits = 0;
  const latencies = [];
  const payloadCommits = config.backend === "feltdb-content" ? 2 : 1;
  const commit = async (build) => {
    const started = performance.now();
    await db.transaction(build);
    latencies.push(performance.now() - started);
    commits += 1;
  };
  const writePayload = async (size) => {
    const ref = await store.write(randomBytes(size));
    commits += payloadCommits;
    return ref;
  };
  const sessions = [];
  const every = Math.max(1, Math.floor(config.turns / config.samples));
  console.log(JSON.stringify({ phase: "baseline", ...memory() }));
  for (let turn = 0; turn < config.turns; turn += 1) {
    clock.t += config.storeSecondsPerTurn * 1000;
    const runId = `wrun_${Math.floor(turn / config.sessionTurns)}`;
    if (turn % config.sessionTurns === 0) {
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
    const sessionEnded = turn % config.sessionTurns === config.sessionTurns - 1;
    if (config.archive && sessionEnded && sessions.length > config.archiveAfterSessions) {
      const old = sessions.shift();
      await commit((tx) => {
        for (const id of old.events) tx.collection("wf_events").delete(id);
        for (const id of old.chunks) tx.collection("wf_chunks").delete(id);
        tx.collection("wf_runs").delete(old.runId);
      });
      for (const ref of old.payloads) await store.remove(ref);
      commits += old.payloads.length * payloadCommits;
    }
    if (turn % 20 === 0) await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    if ((turn + 1) % every === 0) {
      const journal = await db.journalStatus();
      console.log(
        JSON.stringify({
          phase: "sample",
          turns: turn + 1,
          commits,
          ...memory(),
          ...disk(root),
          snapshotMb: mb(journal.persistence.snapshotBytes),
          journalMb: mb(journal.persistence.journalBytes),
          idsRetained: journal.transactionIds.retained,
        }),
      );
    }
  }
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      phase: "written",
      commits,
      commitsPerTurn: +(commits / config.turns).toFixed(1),
      commitMs: {
        p50: +latencies[latencies.length >> 1].toFixed(2),
        p99: +latencies[Math.floor(latencies.length * 0.99)].toFixed(2),
      },
      payloads: await store.usage(),
      ...memory(),
    }),
  );
  await new Promise(() => {});
}

async function verifyAll(root) {
  const { db, store } = open(root);
  const started = performance.now();
  const events = await allRecords(db, "wf_events");
  const chunks = await allRecords(db, "wf_chunks");
  let unverified = 0;
  for (const record of [...events, ...chunks]) {
    if ((await store.verify(record.ref)) !== "ok") unverified += 1;
  }
  const result = {
    events: events.length,
    chunks: chunks.length,
    unverified,
    payloads: await store.usage(),
    verifyMs: Math.round(performance.now() - started),
  };
  await db.close();
  return result;
}

function runWorkloadUntilWritten(root) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), ...args, "--child", "--root", root],
      { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        console.log(line);
        if (line.includes('"phase":"written"')) child.kill("SIGKILL");
      }
    });
    child.once("close", (code, signal) =>
      signal === "SIGKILL"
        ? resolveChild()
        : reject(new Error(`workload exited ${code ?? signal}`)),
    );
  });
}

async function timedOpen(root) {
  const started = performance.now();
  const opened = open(root);
  await opened.db.collection("wf_runs").count();
  const ms = Math.round(performance.now() - started);
  const ids = (await opened.db.journalStatus()).transactionIds;
  const heap = memory();
  await opened.db.close();
  return { ms, ids, heap };
}

if (args.includes("--child")) {
  await workload(option("root"));
} else {
  const source = provenance();
  if (!source.feltdb.transactionIdRetention) {
    throw new Error(
      `${source.feltdb.entry} has no transaction-id retention; set FELTDB_CORE to a build that has it.`,
    );
  }
  if ((source.feltdb.dirty || source.eve.dirty) && !args.includes("--allow-dirty")) {
    throw new Error(
      `refusing to measure uncommitted code (feltdb dirty: ${source.feltdb.dirty}, eve dirty: ${source.eve.dirty}); commit it or pass --allow-dirty`,
    );
  }
  console.log(JSON.stringify({ phase: "provenance", ...source }));
  const root = mkdtempSync(join(tmpdir(), "eve-capacity-"));
  const started = performance.now();
  await runWorkloadUntilWritten(root);
  const writeSeconds = +((performance.now() - started) / 1000).toFixed(1);
  const crashRecovery = await timedOpen(root);
  const cleanReopen = await timedOpen(root);
  const backup = mkdtempSync(join(tmpdir(), "eve-capacity-backup-"));
  const copyStarted = performance.now();
  cpSync(root, backup, { recursive: true });
  const copyMs = Math.round(performance.now() - copyStarted);
  const original = await verifyAll(root);
  const restored = await verifyAll(backup);
  const identical =
    restored.unverified === 0 &&
    original.unverified === 0 &&
    original.events === restored.events &&
    original.chunks === restored.chunks &&
    JSON.stringify(original.payloads) === JSON.stringify(restored.payloads);
  console.log(
    JSON.stringify({
      phase: "summary",
      writeSeconds,
      crashRecovery,
      cleanReopen,
      disk: disk(root),
      backup: { copyMs, original, restored, identical },
    }),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
}

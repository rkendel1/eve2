// Fault injection for durable issue-to-PR execution, on real processes and real persistence:
//   - the AppBoundry host (`appboundry run eve2.app`, FeltDB local state on disk), its own process
//   - the GitHub provider (providers/github.mjs), its own process, killed at a boundary (FAULT_EXIT_AFTER) and restarted
//   - the scripted reasoning provider (providers/scripted-reasoning.mjs): deterministic decisions, NOT a model
//   - a LOCAL STAND-IN FOR GITHUB (github-standin.mjs): REST subset + bare git repository; it survives every kill and
//     counts what was created
// Each scenario runs the whole workflow (assess → prove → file → resolve → gate → publish → report) and checks there is
// exactly one issue, one branch, one pull request and one report comment, that work survived, and that the recovery is
// on record.
//
//   APPBOUNDRY_CLI=<appboundry>/packages/appboundry/dist/bin.js node --test --test-concurrency=1 test/fault/faults.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRepository, startStandin } from "./github-standin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const experiment = join(here, "../..");
const CLI = process.env.APPBOUNDRY_CLI ?? join(experiment, "../../../appboundry/packages/appboundry/dist/bin.js");
const ARTIFACT = join(experiment, "eve2/eve2.app");
const REPOSITORY = "standin/chunks";
const FIXTURE = {
  "package.json": `{ "name": "chunks", "type": "module", "private": true }\n`,
  "src/chunk.js": "export function chunk(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length - size; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n",
  "test/chunk.test.js": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { chunk } from "../src/chunk.js";\n\ntest("an empty list has no chunks", () => {\n  assert.deepEqual(chunk([], 2), []);\n});\n`,
};
const QUIET = Object.fromEntries(["FELTDB_URL", "FELTDB_APPLICATION_ID", "FELTDB_ENVIRONMENT", "FELTDB_MODE", "FELTDB_NAMESPACE", "FELTDB_TOKEN"].map((k) => [k, ""]));
let portBase = 6100;

async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch((e) => { if (e?.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Everything one scenario needs; `fault` is the provider's FAULT_EXIT_AFTER for its first life only. */
async function world(name, { fault = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `eve-fault-${name}-`));
  const logs = join(root, "logs"); mkdirSync(logs);
  const ports = { standin: portBase, reasoning: portBase + 1, github: portBase + 2, host: portBase + 3 };
  portBase += 10;
  createRepository(root, REPOSITORY, FIXTURE);
  const standin = await startStandin({ root, port: ports.standin });
  const checks = join(root, "checks.json");
  writeFileSync(checks, JSON.stringify({ [REPOSITORY]: { prepare: { argv: ["true"], timeoutMs: 60_000 }, test: { argv: ["node", "--test"], target: "path", timeoutMs: 60_000 } } }));
  const tokens = { reasoning: randomBytes(16).toString("hex"), github: randomBytes(16).toString("hex") };
  const procs = {};
  const events = [];
  const start = (key, argv, env, { restartWithout } = {}) => {
    const childEnv = { ...process.env, ...QUIET, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, argv, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const file = join(logs, `${key}.log`);
    child.stdout.on("data", (d) => appendFileSync(file, d)); child.stderr.on("data", (d) => appendFileSync(file, d));
    procs[key] = child;
    child.on("exit", (code) => {
      events.push({ at: Date.now(), process: key, exit: code });
      // The provider is disposable: when it dies at the injected fault, a fresh one (without the fault) takes its place.
      if (restartWithout && code === 137 && !child.stopping) start(key, argv, { ...env, FAULT_EXIT_AFTER: "" });
    });
    return child;
  };
  start("reasoning", [join(experiment, "providers/scripted-reasoning.mjs")], { PORT: String(ports.reasoning), CONSUMER_TOKEN: tokens.reasoning });
  start("github", [join(experiment, "providers/github.mjs")], {
    PORT: String(ports.github), CONSUMER_TOKEN: tokens.github, GITHUB_API_URL: `http://127.0.0.1:${ports.standin}`, GITHUB_GIT_URL: `file://${root}/{repository}.git`,
    GITHUB_REPOSITORIES: REPOSITORY, GITHUB_CHECKS_FILE: checks, GITHUB_WORKDIR: join(root, "workspaces"), GITHUB_FOOTER: "", FAULT_EXIT_AFTER: fault, EVE_GITHUB_TOKEN: "",
  }, { restartWithout: true });
  const bind = (capability, port, provider, env) => ({ capability, version: 1, provider: { applicationId: provider, url: `http://127.0.0.1:${port}/appport` }, credentialEnv: env, grant: { id: `g-${capability}` }, timeoutMs: 30_000 });
  const bindings = join(root, "bindings.json");
  writeFileSync(bindings, JSON.stringify({ bindings: [
    bind("reasoning.decide", ports.reasoning, "reasoning-scripted", "T_REASONING"),
    ...["tracker.items.get", "tracker.items.find", "tracker.items.create", "tracker.items.comment", "code.workspace.open", "code.workspace.status", "code.workspace.list", "code.workspace.read", "code.workspace.search", "code.workspace.write", "code.workspace.run", "code.workspace.result", "code.workspace.diff", "code.changes.publish", "code.changes.find", "code.changes.get"].map((c) => bind(c, ports.github, "github", "T_GITHUB")),
  ] }));
  const startHost = () => start("host", [CLI, "run", ARTIFACT, "--state", join(root, "state"), "--port", String(ports.host), "--capabilities", bindings, "--max-call-ms", "120000"], { T_REASONING: tokens.reasoning, T_GITHUB: tokens.github });
  startHost();
  const base = `http://127.0.0.1:${ports.host}`;
  await until(async () => (await fetch(`${base}/_appboundry/health`)).ok, 30_000, "host");
  await until(async () => (await fetch(`http://127.0.0.1:${ports.github}/`)).status === 401, 15_000, "github provider");
  await until(async () => (await fetch(`http://127.0.0.1:${ports.reasoning}/`)).status === 401, 15_000, "reasoning provider");
  const post = async (path, body, token) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  let operator = (await post("/api/auth/dev", { userId: "operator" })).token;
  const call = async (kind, fn, args) => { const r = await post(`/api/${kind}/${fn}`, { args }, operator); if (!r.ok) throw new Error(`${fn}: ${r.error?.code} ${r.error?.message}`); return r.value; };
  await call("mutation", "tasks:setPolicy", { operation: "assess.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 15, maxIssues: 1, autoResolve: true } });
  await call("mutation", "tasks:setPolicy", { operation: "resolve.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 15, maxFiles: 5, forbiddenPaths: [".github/"], maxGateAttempts: 2 } });
  return {
    root, ports, standin, events, call, procs,
    async restartHost() {
      procs.host.stopping = true; procs.host.kill("SIGKILL");
      await new Promise((r) => procs.host.once("exit", r));
      startHost();
      await until(async () => (await fetch(`${base}/_appboundry/health`)).ok, 30_000, "host after restart");
      operator = (await post("/api/auth/dev", { userId: "operator" })).token;
    },
    tasks: () => call("query", "tasks:list", {}),
    view: (taskId) => call("query", "tasks:get", { taskId }),
    stop() { for (const p of Object.values(procs)) { p.stopping = true; p.kill("SIGTERM"); } standin.server.close(); },
  };
}

/** Run the whole workflow; `during` sees every poll (to interrupt at a chosen point). */
async function runWorkflow(w, during = async () => {}) {
  const first = await w.call("mutation", "work:assign", { operation: "assess", repository: REPOSITORY, assignment: "assess-1" });
  const again = await w.call("mutation", "work:assign", { operation: "assess", repository: REPOSITORY, assignment: "assess-1" });
  assert.equal(again.taskId, first.taskId, "a duplicate delivery is the same task");
  assert.equal(again.duplicate, true);
  return until(async () => {
    const all = await w.tasks();
    await during(all);
    const assess = all.find((t) => t.id === first.taskId);
    const resolve = all.find((t) => t.operation === "resolve");
    const stuck = all.find((t) => ["blocked", "failed", "verification_failed"].includes(t.status));
    if (stuck) throw Object.assign(new Error(`${stuck.operation} ${stuck.id} ${stuck.status}: ${stuck.openQuestion}`), { fatal: true });
    return assess?.status === "completed" && resolve?.status === "completed" ? { assess, resolve, assessId: first.taskId } : null;
  }, 300_000, "the workflow to complete").catch((e) => { throw e; });
}

/** The outcome every scenario must reach: exactly one of each external effect, the verified content published. */
async function assertExactlyOnce(w, { assess, resolve, assessId }) {
  const { state } = w.standin;
  assert.equal(state.issues.length, 1, `exactly one issue (got ${state.issues.map((i) => `#${i.number}`).join(", ")})`);
  assert.equal(state.pulls.length, 1, "exactly one pull request");
  const eveBranches = w.standin.branches(REPOSITORY).filter((b) => b.startsWith("eve/"));
  assert.equal(eveBranches.length, 1, `exactly one eve/ branch (got ${eveBranches.join(", ")})`);
  const reports = state.comments.filter((c) => c.issue === state.issues[0].number);
  assert.equal(reports.length, 1, "exactly one report comment on the issue");
  assert.equal(assess.id, assessId, "the assessment kept its identity");
  assert.equal(assess.report.filed[0].number, state.issues[0].number);
  const rv = await w.view(resolve.id);
  assert.equal(rv.task.work.origin.assessTask, assessId, "the resolution is linked to the assessment");
  assert.equal(Number(rv.task.target.id), state.pulls[0].number);
  const headTree = execFileSync("git", ["rev-parse", `${state.pulls[0].headSha}^{tree}`], { cwd: join(w.root, `${REPOSITORY}.git`) }).toString().trim();
  assert.equal(headTree, rv.task.work.verifiedTree, "the published commit is exactly the tree Eve verified");
  const base = rv.task.report.tests.base.find((b) => b.verdict === "failed_assertion");
  assert.ok(base, "a test fails on the unmodified base on its assertions");
  assert.ok(rv.task.report.tests.change.every((c) => c.exitCode === 0 && c.tree === rv.task.work.verifiedTree), "every named test passes on the verified tree");
  assert.equal(state.pulls[0].state, "open"); // never merged: there is no merge capability
  return rv;
}

const recoveries = async (w, taskId) => {
  const v = await w.view(taskId);
  return { recover: v.executions.filter((e) => e.kind === "recover").map((e) => e.summary), recovery: v.evidence.filter((e) => e.kind === "recovery").map((e) => e.data) };
};

test("baseline: the whole workflow, uninterrupted, produces one issue, one branch, one pull request", async () => {
  const w = await world("baseline");
  try {
    const done = await runWorkflow(w);
    await assertExactlyOnce(w, done);
  } finally { w.stop(); }
});

test("provider killed during assessment (right after it wrote the reproduction): the write is redone, the workflow completes once", async () => {
  const w = await world("assess-kill", { fault: "write#1" });
  try {
    const done = await runWorkflow(w);
    await assertExactlyOnce(w, done);
    assert.ok(w.events.some((e) => e.process === "github" && e.exit === 137), "the provider was killed");
    const r = await recoveries(w, done.assessId);
    assert.ok(r.recover.some((s) => /rebuilt the working copy/.test(s)), `the working copy was rebuilt: ${JSON.stringify(r.recover)}`);
  } finally { w.stop(); }
});

test("issue created, answer lost (provider killed after creating it): reconciled by marker, not filed twice", async () => {
  const w = await world("issue-kill", { fault: "issue.create#1" });
  try {
    const done = await runWorkflow(w);
    await assertExactlyOnce(w, done);
    const r = await recoveries(w, done.assessId);
    assert.ok(r.recover.some((s) => /found #\d+ by its operation marker|already had #\d+ for this operation/.test(s)), `reconciled by marker: ${JSON.stringify(r.recover)}`);
  } finally { w.stop(); }
});

test("provider killed during implementation after the fix was checkpointed: rebuilt from the checkpoint at the same tree", async () => {
  // run.start occurrences: 1 assess repro, 2 prove, 3 resolve after the write — the fix is checkpointed by then.
  const w = await world("implement-kill", { fault: "run.start#3" });
  try {
    const done = await runWorkflow(w);
    const rv = await assertExactlyOnce(w, done);
    const r = await recoveries(w, rv.task.id);
    const rebuilt = r.recovery.filter((x) => x.restore);
    assert.ok(rebuilt.some((x) => x.matches === true && x.files.includes("src/chunk.js")), `rebuilt with the checkpointed fix at the same tree: ${JSON.stringify(rebuilt)}`);
  } finally { w.stop(); }
});

test("interrupted during verification (provider killed as the gate's test run starts): the run is redone on the same tree", async () => {
  // run.start occurrences: 1 assess repro, 2 prove, 3 resolve run, 4 gate change
  const w = await world("verify-kill", { fault: "run.start#4" });
  try {
    const done = await runWorkflow(w);
    const rv = await assertExactlyOnce(w, done);
    const r = await recoveries(w, rv.task.id);
    assert.ok(r.recover.some((s) => /rebuilt the working copy|lost run/.test(s)), `the verification run was recovered: ${JSON.stringify(r.recover)}`);
  } finally { w.stop(); }
});

test("branch pushed, then the provider killed before the pull request: the branch is reconciled, one pull request", async () => {
  const w = await world("push-kill", { fault: "push#1" });
  try {
    const done = await runWorkflow(w);
    const rv = await assertExactlyOnce(w, done);
    const r = await recoveries(w, rv.task.id);
    assert.ok(r.recover.some((s) => /exists at [0-9a-f]{12} with no pull request/.test(s)), `the pushed branch was found before publishing again: ${JSON.stringify(r.recover)}`);
  } finally { w.stop(); }
});

test("pull request created, answer lost (provider killed after creating it): found by its operation, not opened twice", async () => {
  const w = await world("pull-kill", { fault: "pull.create#1" });
  try {
    const done = await runWorkflow(w);
    const rv = await assertExactlyOnce(w, done);
    const r = await recoveries(w, rv.task.id);
    assert.ok(r.recover.some((s) => /exists for this operation|already existed for this operation/.test(s)), `the pull request was reconciled: ${JSON.stringify(r.recover)}`);
  } finally { w.stop(); }
});

test("the host itself killed mid-resolution and restarted on the same state: same tasks, resumed (twice, concurrently), completed once", async () => {
  const w = await world("host-kill");
  let killed = false;
  try {
    const done = await runWorkflow(w, async (all) => {
      const resolve = all.find((t) => t.operation === "resolve");
      if (killed || !resolve || !["implementing", "checking"].includes(resolve.status)) return;
      killed = true;
      const before = (await w.tasks()).map((t) => t.id).sort();
      await w.restartHost();
      assert.deepEqual((await w.tasks()).map((t) => t.id).sort(), before, "the same tasks after the restart");
      // An operator resumes what was in flight; two at once must not double anything.
      for (const t of (await w.tasks()).filter((x) => !["completed"].includes(x.status))) {
        await Promise.all([w.call("mutation", "tasks:resume", { taskId: t.id, reason: "host restarted" }), w.call("mutation", "tasks:resume", { taskId: t.id, reason: "host restarted (again)" }).catch(() => null)]);
      }
    });
    assert.ok(killed, "the host was killed mid-resolution");
    const rv = await assertExactlyOnce(w, done);
    assert.ok(rv.executions.some((e) => e.kind === "recover" && /Resumed by an operator/.test(e.summary)), "the resume is on record");
  } finally { w.stop(); }
});

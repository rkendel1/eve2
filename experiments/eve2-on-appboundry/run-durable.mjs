// The durable live run: Eve2 on AppBoundry discovers a defect in a real repository, files it, resolves it and opens a
// pull request, while the GitHub provider is killed at four boundaries and replaced each time:
//
//   life 1  exits right after GitHub accepts the issue, before answering        (FAULT_EXIT_AFTER=issue.create#1)
//   life 2  SIGKILLed as soon as Eve checkpoints a non-test file in the resolution (watching Eve's own evidence)
//   life 3  exits right after pushing the branch, before the pull request       (FAULT_EXIT_AFTER=push#1)
//   life 4  exits right after GitHub opens the pull request, before answering   (FAULT_EXIT_AFTER=pull.create#1)
//   life 5  runs to the end
//
// Real systems: the AppBoundry host (FeltDB state on disk), Claude (reasoning provider), GitHub (provider through this
// environment's proxy). This script only starts and kills processes, assigns the assessment as the operator, and
// exports what Eve recorded; everything else is Eve's.
//
//   node run-durable.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.APPBOUNDRY_CLI ?? join(here, "../../../appboundry/packages/appboundry/dist/bin.js");
const REPOSITORY = process.env.EVE_REPOSITORY ?? "rkendel1/appboundry";
const PORT = 5400;
const base = `http://127.0.0.1:${PORT}`;
const runDir = join(here, "evidence/durable", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });
const LIVES = ["issue.create#1", "watch:checkpoint", "push#1", "pull.create#1", ""];
const timeline = [];
const note = (event, detail = {}) => { const e = { at: new Date().toISOString(), event, ...detail }; timeline.push(e); console.log(`• ${event} ${JSON.stringify(detail)}`); };
const children = new Set();
let stopping = false;

function start(name, argv, env, onExit) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, argv, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => appendFileSync(join(runDir, `${name}.log`), d));
  children.add(child);
  child.on("exit", (code, signal) => { children.delete(child); if (!stopping) onExit?.(code, signal); });
  return child;
}
async function until(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`${url} did not come up`);
}
const post = async (path, body, token) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();

const tokens = { reasoning: randomBytes(24).toString("hex"), github: randomBytes(24).toString("hex") };
start("provider-reasoning", [join(here, "providers/reasoning.mjs")], { PORT: "5410", CONSUMER_TOKEN: tokens.reasoning });

// The GitHub provider, supervised: each life gets its fault; when it dies, the next life starts in its place.
let life = 0;
let provider = null;
function startProvider() {
  const plan = LIVES[Math.min(life, LIVES.length - 1)];
  life += 1;
  const fault = plan.startsWith("watch:") || !plan ? "" : plan;
  note("provider.start", { life, plan: plan || "run to the end" });
  provider = start(`provider-github-life${life}`, [join(here, "providers/github.mjs")], {
    NODE_USE_ENV_PROXY: "1", GITHUB_TOKEN: "", GH_TOKEN: "", PORT: "5440", CONSUMER_TOKEN: tokens.github, GITHUB_REPOSITORIES: REPOSITORY,
    GITHUB_WORKDIR: join(here, ".state/workspaces"), FAULT_EXIT_AFTER: fault,
  }, (code, signal) => { note("provider.exit", { life, code, signal }); setTimeout(startProvider, 1_000); });
  provider.plan = plan;
}
startProvider();

const bind = (capability, port, provider, env, timeoutMs) => ({ capability, version: 1, provider: { applicationId: provider, url: `http://127.0.0.1:${port}/appport` }, credentialEnv: env, grant: { id: `grant-eve2-${capability}` }, timeoutMs });
const bindings = { bindings: [
  bind("reasoning.interpret", 5410, "reasoning-claude", "TOKEN_REASONING", 120_000), bind("reasoning.decide", 5410, "reasoning-claude", "TOKEN_REASONING", 120_000),
  ...["tracker.items.get", "tracker.items.find", "tracker.items.create", "tracker.items.comment"].map((c) => bind(c, 5440, "github", "TOKEN_GITHUB", 60_000)),
  bind("code.workspace.open", 5440, "github", "TOKEN_GITHUB", 120_000),
  ...["code.workspace.status", "code.workspace.list", "code.workspace.read", "code.workspace.search", "code.workspace.write", "code.workspace.diff"].map((c) => bind(c, 5440, "github", "TOKEN_GITHUB", 45_000)),
  bind("code.workspace.run", 5440, "github", "TOKEN_GITHUB", 45_000), bind("code.workspace.result", 5440, "github", "TOKEN_GITHUB", 40_000),
  bind("code.changes.publish", 5440, "github", "TOKEN_GITHUB", 120_000), bind("code.changes.find", 5440, "github", "TOKEN_GITHUB", 120_000), bind("code.changes.get", 5440, "github", "TOKEN_GITHUB", 60_000),
] };
writeFileSync(join(runDir, "bindings.json"), JSON.stringify(bindings, null, 2));
start("appboundry-host", [CLI, "run", join(here, "eve2/eve2.app"), "--state", join(runDir, "state"), "--port", String(PORT), "--capabilities", join(runDir, "bindings.json"), "--max-call-ms", "300000"], { TOKEN_REASONING: tokens.reasoning, TOKEN_GITHUB: tokens.github });
await until(`${base}/_appboundry/health`);
await until("http://127.0.0.1:5410/"); await until("http://127.0.0.1:5440/");

const operator = (await post("/api/auth/dev", { userId: "operator" })).token;
const call = async (kind, name, args) => { const r = await post(`/api/${kind}/${name}`, { args }, operator); if (!r.ok) throw new Error(`${name}: ${r.error?.code} ${r.error?.message}`); return r.value; };
await call("mutation", "tasks:setPolicy", { operation: "assess.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 40, maxIssues: 1, autoResolve: true } });
await call("mutation", "tasks:setPolicy", { operation: "resolve.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 40, maxFiles: 5, forbiddenPaths: [".github/", "pnpm-lock.yaml", "package-lock.json", "package.json"], maxGateAttempts: 2 } });

const objective = process.env.EVE_OBJECTIVE ?? [
  `Review ${REPOSITORY} for an unresolved reliability defect in packages/appboundry-host (the artifact host: guest execution and limits, collections and transactions, identity and sessions, backups, the capability ledger).`,
  "The after-commit outbox (performOutbox, recoverOutbox, retryOutbox) is already tracked in issue #99; look elsewhere.",
  "Find one defect you can prove with a failing test.",
].join(" ");
const assigned = await call("mutation", "work:assign", { operation: "assess", repository: REPOSITORY, objective, assignment: `durable-${Date.now()}` });
note("assess.assigned", { taskId: assigned.taskId });

let lastLine = "", changedAt = Date.now(), lastProgress = "";
const started = Date.now();
let result = null;
try {
  for (;;) {
    const all = await call("query", "tasks:list", {});
    for (const t of all) {
      const line = `${t.operation} ${t.id} ${t.status}${t.work?.decisions ? ` decisions=${t.work.decisions}` : ""}${t.openQuestion ? ` — ${t.openQuestion}` : ""}`;
      if (!lastLine.includes(line)) console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`);
    }
    const lines = all.map((t) => `${t.operation} ${t.id} ${t.status}${t.work?.decisions ? ` decisions=${t.work.decisions}` : ""}${t.openQuestion ? ` — ${t.openQuestion}` : ""}`).join("\n");
    const progress = all.map((t) => `${t.id}:${t.status}:${t.steps}`).join(",");
    if (progress !== lastProgress) { lastProgress = progress; changedAt = Date.now(); }
    lastLine = lines;
    // Life 2: kill the provider as soon as the resolution has checkpointed a change to a non-test file.
    const resolve = all.find((t) => t.operation === "resolve");
    if (provider?.plan === "watch:checkpoint" && resolve && !provider.killed) {
      const files = Object.keys(resolve.work?.checkpoint?.files ?? {});
      const fix = files.find((p) => !/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(p));
      if (fix) { provider.killed = true; note("provider.kill", { life, after: `checkpoint of ${fix}`, checkpoint: resolve.work.checkpoint.seq, tree: resolve.work.checkpoint.tree }); provider.kill("SIGKILL"); }
    }
    const assess = all.find((t) => t.id === assigned.taskId);
    const ended = (t) => ["completed", "blocked", "failed", "verification_failed"].includes(t?.status);
    if (ended(assess) && (assess.status !== "completed" || !assess.report?.filed?.length || ended(resolve))) { result = { assess, resolve }; break; }
    if (Date.now() - changedAt > 600_000) { note("stalled", { lines }); break; }
    await new Promise((r) => setTimeout(r, 3_000));
  }
} finally {
  const views = {};
  for (const t of await call("query", "tasks:list", {})) { views[t.id] = await call("query", "tasks:get", { taskId: t.id }); writeFileSync(join(runDir, `${t.operation}-${t.id}.json`), JSON.stringify(views[t.id], null, 2)); }
  const usage = Object.values(views).flatMap((v) => v.evidence.filter((e) => e.kind === "model_usage").map((e) => e.data)).reduce((a, u) => ({ calls: a.calls + 1, inputTokens: a.inputTokens + (u.inputTokens ?? 0), cacheWriteTokens: a.cacheWriteTokens + (u.cacheWriteTokens ?? 0), cacheReadTokens: a.cacheReadTokens + (u.cacheReadTokens ?? 0), outputTokens: a.outputTokens + (u.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  const summary = { startedAt: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), providerLives: life, timeline, tasks: Object.values(views).map((v) => ({ id: v.task.id, operation: v.task.operation, status: v.task.status, steps: v.task.steps, decisions: v.task.work?.decisions, restores: v.task.work?.restores, report: v.task.report ?? null, recoveries: v.executions.filter((e) => e.kind === "recover").map((e) => e.summary) })), model: usage };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, timeline: undefined }, null, 2));
  console.log(`Evidence: ${runDir}`);
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
}

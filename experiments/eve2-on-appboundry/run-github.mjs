// The first live run: Eve2 on AppBoundry working on a real repository through the GitHub and Claude providers.
//
//   node run-github.mjs assess            review the repository, prove findings, file issues for proven ones
//   node run-github.mjs resolve <number>  take an issue to a pull request (never merged)
//   node run-github.mjs chain             assess, then resolve the most severe issue Eve filed
//
// Everything Eve does goes through the host's capability bindings; this script only starts processes, assigns work as
// the operator, and exports what Eve recorded.
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
const runDir = join(here, "evidence/github", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });
const children = [];
const stop = () => { for (const c of children) c.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(130); });

function start(name, argv, env) {
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => appendFileSync(join(runDir, `${name}.log`), d));
  children.push(child);
}
async function until(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`${url} did not come up`);
}
const post = async (path, body, token) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();

const tokens = { reasoning: randomBytes(24).toString("hex"), github: randomBytes(24).toString("hex") };
start("provider-reasoning", [join(here, "providers/reasoning.mjs")], { PORT: "5410", CONSUMER_TOKEN: tokens.reasoning });
start("provider-github", [join(here, "providers/github.mjs")], { NODE_USE_ENV_PROXY: "1", GITHUB_TOKEN: "", GH_TOKEN: "", PORT: "5440", CONSUMER_TOKEN: tokens.github, GITHUB_REPOSITORIES: REPOSITORY, GITHUB_WORKDIR: join(here, ".state/workspaces") });
const bind = (capability, port, provider, env, timeoutMs) => ({ capability, version: 1, provider: { applicationId: provider, url: `http://127.0.0.1:${port}/appport` }, credentialEnv: env, grant: { id: `grant-eve2-${capability}` }, timeoutMs });
const bindings = { bindings: [
  bind("reasoning.interpret", 5410, "reasoning-claude", "TOKEN_REASONING", 120_000), bind("reasoning.decide", 5410, "reasoning-claude", "TOKEN_REASONING", 120_000),
  ...["tracker.items.get", "tracker.items.find", "tracker.items.create", "tracker.items.comment"].map((c) => bind(c, 5440, "github", "TOKEN_GITHUB", 30_000)),
  bind("code.workspace.open", 5440, "github", "TOKEN_GITHUB", 120_000),
  ...["code.workspace.list", "code.workspace.read", "code.workspace.search", "code.workspace.write", "code.workspace.diff"].map((c) => bind(c, 5440, "github", "TOKEN_GITHUB", 30_000)),
  bind("code.workspace.run", 5440, "github", "TOKEN_GITHUB", 45_000), bind("code.workspace.result", 5440, "github", "TOKEN_GITHUB", 40_000),
  bind("code.changes.publish", 5440, "github", "TOKEN_GITHUB", 60_000), bind("code.changes.get", 5440, "github", "TOKEN_GITHUB", 30_000),
] };
writeFileSync(join(runDir, "bindings.json"), JSON.stringify(bindings, null, 2));
start("appboundry-host", [CLI, "run", join(here, "eve2/eve2.app"), "--state", join(runDir, "state"), "--port", String(PORT), "--capabilities", join(runDir, "bindings.json"), "--max-call-ms", "300000"], { TOKEN_REASONING: tokens.reasoning, TOKEN_GITHUB: tokens.github });
await until(`${base}/_appboundry/health`);
await until("http://127.0.0.1:5410/"); await until("http://127.0.0.1:5440/");

const operator = (await post("/api/auth/dev", { userId: "operator" })).token;
const call = async (kind, name, args) => {
  const r = await post(`/api/${kind}/${name}`, { args }, operator);
  if (!r.ok) throw new Error(`${name}: ${r.error?.code} ${r.error?.message}`);
  return r;
};
await call("mutation", "tasks:setPolicy", { operation: "assess.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 40, maxIssues: 2 } });
await call("mutation", "tasks:setPolicy", { operation: "resolve.repository", requiresApproval: false, reconcileBeforeRetry: true, maxAttempts: 2, limits: { repositories: [REPOSITORY], maxDecisions: 40, maxFiles: 5, forbiddenPaths: [".github/", "pnpm-lock.yaml", "package-lock.json", "package.json"], maxGateAttempts: 2 } });

const metrics = { startedAt: new Date().toISOString() };
async function follow(taskId, label) {
  const started = Date.now();
  let last = "", lastProgress = "", changedAt = Date.now();
  for (;;) {
    const view = (await call("query", "tasks:get", { taskId })).value;
    const t = view.task;
    const line = `${t.status}${t.work?.decisions ? ` decisions=${t.work.decisions}` : ""}${t.openQuestion ? ` — ${t.openQuestion}` : ""}`;
    const progress = `${line} ${t.steps}`;
    if (progress !== lastProgress) { lastProgress = progress; changedAt = Date.now(); }
    if (line !== last) { console.log(`[${label} ${Math.round((Date.now() - started) / 1000)}s] ${line}`); last = line; }
    if (Date.now() - changedAt > 300_000) { console.log(`[${label}] STALLED: no progress for 5 minutes at ${t.status}`); writeFileSync(join(runDir, `${label}-${taskId}.json`), JSON.stringify(view, null, 2)); metrics[label] = { taskId, status: `stalled at ${t.status}` }; return t; }
    if (["completed", "blocked", "failed", "verification_failed", "needs_clarification", "needs_approval"].includes(t.status)) {
      writeFileSync(join(runDir, `${label}-${taskId}.json`), JSON.stringify(view, null, 2));
      metrics[label] = { taskId, status: t.status, seconds: Math.round((Date.now() - started) / 1000), steps: t.steps, decisions: t.work?.decisions ?? 0,
        model: view.evidence.filter((e) => e.kind === "model_usage").reduce((a, e) => ({ calls: a.calls + 1, inputTokens: a.inputTokens + (e.data.inputTokens ?? 0), cacheWriteTokens: a.cacheWriteTokens + (e.data.cacheWriteTokens ?? 0), cacheReadTokens: a.cacheReadTokens + (e.data.cacheReadTokens ?? 0), outputTokens: a.outputTokens + (e.data.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }),
        invocations: view.executions.filter((e) => e.kind === "invoke").length, report: t.report ?? null };
      return t;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

try {
  const mode = process.argv[2] ?? "chain";
  let issue = mode === "resolve" ? Number(process.argv[3]) : null;
  if (mode === "assess" || mode === "chain") {
    const objective = process.env.EVE_OBJECTIVE ?? `Review ${REPOSITORY} for unresolved reliability gaps, starting with packages/appboundry-host (the artifact host: guest execution, collections and transactions, identity, backups). Find problems you can substantiate, with evidence.`;
    const { value } = await call("mutation", "work:assign", { operation: "assess", repository: REPOSITORY, objective, assignment: `assess-${Date.now()}` });
    const done = await follow(value.taskId, "assess");
    issue = mode === "chain" ? done.report?.filed?.[0]?.number ?? null : null;
    if (mode === "chain" && !issue) console.log("Eve filed no issue, so there is nothing to resolve.");
  }
  if (issue) {
    const { value } = await call("mutation", "work:assign", { operation: "resolve", repository: REPOSITORY, item: issue, assignment: `resolve-${issue}` });
    await follow(value.taskId, "resolve");
  }
} finally {
  metrics.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Evidence: ${runDir}`);
  stop();
}

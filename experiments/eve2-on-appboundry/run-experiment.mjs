// Runs Eve2 on AppBoundry against the real systems: the three providers (each its own process, each holding its own
// access) and the AppBoundry host running eve2.app with the operator's bindings. Eve2 itself holds nothing.
//
//   node run-experiment.mjs            start everything, set the policy, and keep running (Ctrl-C stops)
//   node run-experiment.mjs --status   print every task with its status and open question
//
// Environment (the providers read their own; this script passes them through):
//   Slack       SLACK_CHANNEL_ID, and a slack.com network secret or SLACK_BOT_TOKEN
//   QuickBooks  QBO_REALM_ID, QBO_REFRESH_TOKEN (first run), an oauth.platform.intuit.com secret or QBO_CLIENT_ID/SECRET
//   Claude      BENCH_API_KEY (or ANTHROPIC_API_KEY)
//   Policy      EVE_APPROVERS (comma-separated Slack user ids), EVE_MAX_AMOUNT (default 1000), EVE_CURRENCY (default USD)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.APPBOUNDRY_CLI ?? join(here, "../../../appboundry/packages/appboundry/dist/bin.js");
const ARTIFACT = join(here, "eve2/eve2.app");
const STATE = process.env.EVE_STATE ?? join(here, ".state/eve2");
const HOST_PORT = Number(process.env.EVE_PORT ?? 5400);
const base = `http://127.0.0.1:${HOST_PORT}`;
const evidenceDir = join(here, "evidence/runs", new Date().toISOString().replace(/[:.]/g, "-"));

async function until(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error(`${url} did not come up`);
}
const session = async (userId) => (await (await fetch(`${base}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) })).json()).token;
const call = async (token, kind, name, args) => (await fetch(`${base}/api/${kind}/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ args }) })).json();

if (process.argv.includes("--status")) {
  const operator = await session("operator");
  const tasks = (await call(operator, "query", "tasks:list", {})).value ?? [];
  for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(20)} ${t.sourceKey}  ${t.openQuestion ?? ""}`);
  process.exit(0);
}

mkdirSync(evidenceDir, { recursive: true });
const children = [];
function start(name, script, env) {
  const child = spawn(process.execPath, [script, ...(env.ARGS ?? [])], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = join(evidenceDir, `${name}.log`);
  child.stdout.on("data", d => appendFileSync(out, d));
  child.stderr.on("data", d => appendFileSync(out, d));
  children.push({ name, child });
  return child;
}
process.on("SIGINT", () => { for (const c of children) c.child.kill("SIGTERM"); process.exit(0); });

// Each provider issues its consumer a credential; the host holds them (environment of the host process only).
const tokens = { reasoning: randomBytes(24).toString("hex"), slack: randomBytes(24).toString("hex"), quickbooks: randomBytes(24).toString("hex") };
start("provider-reasoning", join(here, "providers/reasoning.mjs"), { PORT: "5410", CONSUMER_TOKEN: tokens.reasoning });
start("provider-quickbooks", join(here, "providers/quickbooks.mjs"), { PORT: "5430", CONSUMER_TOKEN: tokens.quickbooks, QBO_TOKEN_FILE: join(here, ".qbo-token.json") });

const bind = (capability, port, provider, timeoutMs = 10000) => ({ capability, version: 1, provider: { applicationId: provider, url: `http://127.0.0.1:${port}/appport` }, credentialEnv: `TOKEN_${provider.toUpperCase().replace(/-/g, "_")}`, grant: { id: `grant-eve2-${capability}` }, timeoutMs });
const bindings = { bindings: [
  bind("conversation.messages.get", 5420, "slack"), bind("conversation.messages.reply", 5420, "slack"),
  bind("reasoning.interpret", 5410, "reasoning-claude", 60000),
  ...["finance.parties.find", "finance.accounts.find", "finance.documents.find", "finance.documents.create", "finance.documents.get"].map(c => bind(c, 5430, "quickbooks", 15000)),
] };
writeFileSync(join(evidenceDir, "bindings.json"), JSON.stringify(bindings, null, 2));
start("appboundry-host", CLI, { ARGS: ["run", ARTIFACT, "--state", STATE, "--port", String(HOST_PORT), "--capabilities", join(evidenceDir, "bindings.json"), "--max-call-ms", "120000"], TOKEN_SLACK: tokens.slack, TOKEN_REASONING_CLAUDE: tokens.reasoning, TOKEN_QUICKBOOKS: tokens.quickbooks });
await until(`${base}/_appboundry/health`);

const operator = await session("operator");
const policy = await call(operator, "mutation", "tasks:setPolicy", {
  operation: "record.bill", requiresApproval: true, approvalReaction: "white_check_mark", approvers: (process.env.EVE_APPROVERS ?? "").split(",").filter(Boolean),
  maxAmount: Number(process.env.EVE_MAX_AMOUNT ?? 1000), currency: process.env.EVE_CURRENCY ?? "USD", reconcileBeforeRetry: true, maxAttempts: 2,
});
console.log("policy", JSON.stringify(policy.value));
// The Slack provider's source side delivers requests as the operator-issued `source` session.
start("provider-slack", join(here, "providers/slack.mjs"), { PORT: "5420", CONSUMER_TOKEN: tokens.slack, EVE_URL: base, EVE_SOURCE_TOKEN: await session("source-connector") });
await until("http://127.0.0.1:5420/");
console.log(`Eve2 is running on ${base}. Logs and bindings: ${evidenceDir}`);
console.log((await call(operator, "query", "tasks:capabilities", {})).value?.map(c => `  ${c.name.padEnd(30)} ${c.status}${c.provider?.reachable === false ? " (unreachable)" : ""}`).join("\n"));

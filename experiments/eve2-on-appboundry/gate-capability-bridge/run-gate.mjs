// Gate 4: host execution proof. The FeltKit-built artifact runs on the AppBoundry host (its own process), and
// reaches an independently running AppPort provider (its own process) only through capabilities@1.
// Everything here talks HTTP to those processes; nothing is called in process.
//
//   APPBOUNDRY_CLI=<appboundry repo>/packages/appboundry/dist/bin.js node run-gate.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.APPBOUNDRY_CLI ?? join(here, "../../../../appboundry/packages/appboundry/dist/bin.js");
const ARTIFACT = join(here, "app/ledgerbridge.app");
const PROVIDER_PORT = 5301, HOST_PORT = 5302;
const work = mkdtempSync(join(tmpdir(), "gate-"));
const token = randomBytes(24).toString("base64url");
const steps = [];
const children = [];
const record = (step, data) => { steps.push({ at: new Date().toISOString(), step, ...data }); console.log(`• ${step}`, JSON.stringify(data)); };
const check = (cond, what) => { if (!cond) throw new Error(`GATE FAILED: ${what}`); record("check", { ok: true, what }); };

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  child.stdout.on("data", d => lines.push(...String(d).trim().split("\n")));
  child.stderr.on("data", d => lines.push(...String(d).trim().split("\n")));
  children.push({ name, child, lines });
  return { child, lines };
}
async function until(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`${url} did not come up`);
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

try {
  // The provider: its own process, its own credential for this consumer.
  const provider = start("books-provider", process.execPath, [join(here, "provider/books.mjs")], { PORT: String(PROVIDER_PORT), BOOKS_CONSUMER_TOKEN: token });
  await until(`http://127.0.0.1:${PROVIDER_PORT}/__state`);
  // The operator's bindings: create is granted, void is offered without a grant. The credential is an env var of the
  // host process, named here; the artifact never sees it.
  const bindings = join(work, "bindings.json");
  writeFileSync(bindings, JSON.stringify({ bindings: [
    { capability: "books.invoices.create", version: 1, provider: { applicationId: "books", url: `http://127.0.0.1:${PROVIDER_PORT}/appport` }, credentialEnv: "BOOKS_TOKEN", grant: { id: "grant-ledgerbridge-books-create" }, timeoutMs: 1500 },
    { capability: "books.invoices.void", version: 1, provider: { applicationId: "books", url: `http://127.0.0.1:${PROVIDER_PORT}/appport` }, credentialEnv: "BOOKS_TOKEN" },
  ] }, null, 2));
  const state = join(work, "state");
  const host = start("appboundry", process.execPath, [CLI, "run", ARTIFACT, "--state", state, "--port", String(HOST_PORT), "--capabilities", bindings], { BOOKS_TOKEN: token });
  await until(`http://127.0.0.1:${HOST_PORT}/_appboundry/health`);
  const base = `http://127.0.0.1:${HOST_PORT}`;
  const artifactInfo = await json(await fetch(`${base}/_appboundry/artifact`));
  record("host.artifact", { application: artifactInfo.body?.application, module: artifactInfo.body?.module?.sha256 ?? artifactInfo.body?.moduleSha256, permissions: artifactInfo.body?.permissions });

  const session = (await json(await fetch(`${base}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "ada" }) }))).body;
  const call = async (kind, name, args) => (await json(await fetch(`${base}/api/${kind}/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ args }) }))).body;

  // 1. Discovery: granted vs offered; discovery grants nothing.
  const listed = await call("query", "bridge:available", {});
  record("discover", { listed: listed.value?.map(c => ({ name: c.name, status: c.status, reachable: c.provider?.reachable, description: c.description })) });
  check(listed.ok && listed.value.find(c => c.name === "books.invoices.create")?.status === "granted", "create is discovered as granted");
  check(listed.value.find(c => c.name === "books.invoices.void")?.status === "offered", "void is discoverable but not granted");

  // 2. Invoke: the provider's real state changes.
  const posted = await call("mutation", "bridge:post", { key: "gate-001", amount: 450 });
  record("invoke.create", { result: posted.value });
  check(posted.ok && posted.value.outcome === "succeeded", "create succeeded through AppPort");

  // 3. Same key again: replayed by the host's ledger, nothing sent.
  const replay = await call("mutation", "bridge:post", { key: "gate-001", amount: 450 });
  record("invoke.replay", { result: replay.value });
  check(replay.value.outcome === "succeeded" && replay.value.replayed === true, "same key replays without resending");

  // 4. Authority at the boundary: offered but not granted.
  const voided = await call("mutation", "bridge:post", { key: "void-001", amount: 1, capability: "books.invoices.void" });
  record("invoke.ungranted", { result: voided.value });
  check(voided.value.outcome === "refused" && voided.value.error.code === "NOT_GRANTED", "ungranted capability refused before sending");

  // 5. Provider without the credential: the provider refuses on its own.
  const direct = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/appport`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  record("provider.without-credential", { status: direct.status });
  check(direct.status === 401, "the provider refuses a caller without its credential");

  // 6. Timeout after effect: unknown, never failed; resend with the same key does not duplicate.
  await fetch(`http://127.0.0.1:${PROVIDER_PORT}/__control`, { method: "POST", body: JSON.stringify({ delayMs: 3000 }) });
  const slow = await call("mutation", "bridge:post", { key: "gate-002", amount: 75 });
  record("invoke.timeout", { result: slow.value });
  check(slow.value.outcome === "unknown", "a timeout is recorded as unknown");
  await new Promise(r => setTimeout(r, 3200));
  const resent = await call("mutation", "bridge:post", { key: "gate-002", amount: 75 });
  record("invoke.resend-same-key", { result: resent.value });
  check(resent.value.outcome === "succeeded" && resent.value.attempt === 2, "resend with the same key succeeds as attempt 2");

  const books = await json(await fetch(`http://127.0.0.1:${PROVIDER_PORT}/__state`));
  record("provider.state", books.body);
  check(books.body.invoices.length === 2, "the provider holds exactly two invoices (no duplicate effect)");

  const history = await call("query", "bridge:history", {});
  record("app.state", { attempts: history.value?.map(a => ({ key: a.key, outcome: a.outcome, detail: a.detail })) });

  // 7. Durable evidence, read through the operator's export of the host's state after the host stops.
  host.child.kill("SIGTERM");
  await new Promise(r => host.child.once("exit", r));
  const backup = join(work, "backup.ndjson");
  execFileSync(process.execPath, [CLI, "admin", "export", "--state", state, "--out", backup], { encoding: "utf8" });
  const outbound = readFileSync(backup, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(l => l.c === "_appboundry_outbound").map(l => l.r);
  record("evidence.outbound", { records: outbound });
  check(outbound.length === 2, "the host's state holds both outbound records after the host stopped");

  // No companion: the artifact declares no components and does not require components@1, so the host has nothing to run beside it.
  const manifest = JSON.parse(readFileSync(join(ARTIFACT, "manifest.json"), "utf8"));
  check(!manifest.components && manifest.runtime.interfaces.components === undefined, "the artifact declares no companion components (no components@1)");
  check(manifest.producer.name === "feltkit" && manifest.runtime.interfaces.capabilities === 1, "produced by FeltKit, requiring capabilities@1");
  record("result", { gate: "PASS", processes: children.map(c => c.name) });
} catch (error) {
  record("result", { gate: "FAIL", error: String(error.message ?? error) });
  process.exitCode = 1;
} finally {
  for (const c of children) { c.child.kill("SIGTERM"); steps.push({ step: `log.${c.name}`, lines: c.lines.slice(-40) }); }
  mkdirSync(join(here, "evidence"), { recursive: true });
  writeFileSync(join(here, "evidence/gate-run.json"), `${JSON.stringify({ artifact: ARTIFACT, steps }, null, 2)}\n`);
}

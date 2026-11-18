import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "appport-agent-acceptance-"));
const provenanceFile = join(scratch, "provenance.jsonl");
const ASSERTION_SECRET = "acceptance-assertion-secret-0123456789abcdef";
const AGENT_JWT_SECRET = "acceptance-agent-jwt-secret-0123456789abcdef";
const APPPORT_PORT = 4400 + Math.floor(Math.random() * 400);
const APPPORT_URL = `http://127.0.0.1:${APPPORT_PORT}/appport`;
const ANTHROPIC_API_KEY = process.env.APPPORT_AGENT_E2E_ANTHROPIC_API_KEY ?? "";
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const catalog = JSON.parse(readFileSync(join(root, "appport-host/catalog.json"), "utf8"));

const children = [];

function cleanEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("VERCEL") || name.endsWith("_API_KEY") || name.startsWith("APPPORT_"))
      continue;
    env[name] = value;
  }
  return { ...env, EVE_TELEMETRY_DISABLED: "1", NODE_ENV: "production", ...extra };
}

function startProcess(command, args, env, readyPattern) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const match = readyPattern.exec(output);
      if (match) resolve({ child, output: () => output, url: match[1] });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) =>
      reject(new Error(`${command} exited (${code}) before ready:\n${output}`)),
    );
    setTimeout(() => reject(new Error(`${command} not ready in time:\n${output}`)), 90_000).unref();
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function provenance() {
  if (!existsSync(provenanceFile)) return [];
  return readFileSync(provenanceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let lib;

before(async () => {
  await startProcess(
    process.execPath,
    ["appport-host/server.mjs"],
    cleanEnv({
      APPPORT_AGENT_ASSERTION_SECRET: ASSERTION_SECRET,
      APPPORT_PORT: String(APPPORT_PORT),
      APPPORT_PROVENANCE_FILE: provenanceFile,
    }),
    /\[appport\] inventory listening at (\S+)/u,
  );
  process.env.APPPORT_URL = APPPORT_URL;
  process.env.APPPORT_AGENT_ASSERTION_SECRET = ASSERTION_SECRET;
  process.env.APPPORT_AGENT_CAPABILITIES = "catalog.lookup";
  lib = await import("../agent/lib/appport.ts");
});

after(async () => {
  await Promise.all(children.map(stop));
  rmSync(scratch, { force: true, recursive: true });
});

describe("AppPort integration (real AppPort over HTTP, no model)", () => {
  it("discovers the read-only capability and marks it invocable", async () => {
    const capabilities = await lib.listCapabilities({ principalId: ALICE });
    assert.deepEqual(capabilities, [
      {
        authorization: ["catalog.read"],
        description: "Reads one catalog item by SKU. Read-only.",
        effect: "observation",
        invocable: true,
        name: "catalog.lookup",
        version: 1,
      },
    ]);
  });

  it("reads the capability's contract and input schema", async () => {
    const contract = await lib.readContract({ principalId: ALICE }, "catalog.lookup");
    assert.equal(contract.found, true);
    assert.equal(contract.effect, "observation");
    assert.deepEqual(contract.inputSchema.required, ["sku"]);
    assert.equal(contract.inputSchema.properties.sku.type, "string");
  });

  it("invokes it for an authorized caller with a result that matches the source data", async () => {
    const result = await lib.invokeCapability(
      { principalId: ALICE },
      "catalog.lookup",
      { sku: "ALPHA-1" },
      "trace-alice",
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.output,
      catalog.items.find((item) => item.sku === "ALPHA-1"),
    );
    const record = provenance().find((entry) => entry.requestId === result.requestId);
    assert.equal(record.success, true);
    assert.equal(record.principal, ALICE);
    assert.match(record.sessionId, /^agent_[0-9a-f-]{36}$/u);
    assert.equal(record.capability, "catalog.lookup");
  });

  it("rejects a caller without the permission", async () => {
    const result = await lib.invokeCapability(
      { principalId: BOB },
      "catalog.lookup",
      { sku: "ALPHA-1" },
      undefined,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "FORBIDDEN");
    const record = provenance().find((entry) => entry.requestId === result.requestId);
    assert.equal(record.errorCode, "FORBIDDEN");
    assert.equal(record.principal, BOB);
  });

  it("treats a forged caller assertion as anonymous", async () => {
    process.env.APPPORT_AGENT_ASSERTION_SECRET = "not-the-shared-secret-0123456789abcdef";
    try {
      const result = await lib.invokeCapability(
        { principalId: ALICE },
        "catalog.lookup",
        { sku: "ALPHA-1" },
        undefined,
      );
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UNAUTHORIZED");
    } finally {
      process.env.APPPORT_AGENT_ASSERTION_SECRET = ASSERTION_SECRET;
    }
  });

  it("rejects input that violates the contract", async () => {
    for (const input of [{}, { sku: 5 }]) {
      const result = await lib.invokeCapability(
        { principalId: ALICE },
        "catalog.lookup",
        input,
        undefined,
      );
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_INPUT");
    }
  });

  it("never sends a capability the operator did not expose", async () => {
    process.env.APPPORT_AGENT_CAPABILITIES = "";
    try {
      const lookups = () =>
        provenance().filter((entry) => entry.capability === "catalog.lookup").length;
      const before = lookups();
      const result = await lib.invokeCapability(
        { principalId: ALICE },
        "catalog.lookup",
        { sku: "ALPHA-1" },
        undefined,
      );
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "NOT_EXPOSED");
      assert.equal(lookups(), before);
    } finally {
      process.env.APPPORT_AGENT_CAPABILITIES = "catalog.lookup";
    }
  });
});

function signAgentJwt(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    aud: "appport-agent",
    exp: now + 600,
    iat: now,
    iss: "appport-agent-operator",
    sub,
  });
  return `${header}.${payload}.${createHmac("sha256", AGENT_JWT_SECRET).update(`${header}.${payload}`).digest("base64url")}`;
}

async function turn(agentUrl, user, message, sessionId) {
  const headers = {
    authorization: `Bearer ${signAgentJwt(user)}`,
    "content-type": "application/json",
  };
  const path = sessionId === undefined ? "/eve/v1/session" : `/eve/v1/session/${sessionId}`;
  const created = await fetch(new URL(path, agentUrl), {
    body: JSON.stringify({ message }),
    headers,
    method: "POST",
  });
  assert.ok(created.ok, `send failed with HTTP ${created.status}`);
  const id = sessionId ?? (await created.json()).sessionId;
  const stream = await fetch(new URL(`/eve/v1/session/${id}/stream`, agentUrl), {
    headers,
    signal: AbortSignal.timeout(180_000),
  });
  const decoder = new TextDecoder();
  let buffered = "";
  let replies = [];
  let settled = 0;
  const target = sessionId === undefined ? 1 : 2;
  for await (const chunk of stream.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      for (const fact of JSON.parse(line).facts ?? []) {
        if (fact.type === "content.completed" && fact.data.kind === "text")
          replies.push(fact.data.value);
        if (fact.type === "turn.settled") settled += 1;
      }
      if (settled >= target) return { reply: replies.at(-1) ?? "", sessionId: id };
    }
  }
  return { reply: replies.at(-1) ?? "", sessionId: id };
}

describe("eve agent end to end (real Anthropic model)", { skip: ANTHROPIC_API_KEY === "" }, () => {
  let agent;
  const agentEnv = () =>
    cleanEnv({
      AGENT_JWT_SECRET,
      ANTHROPIC_API_KEY,
      APPPORT_AGENT_ASSERTION_SECRET: ASSERTION_SECRET,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup",
      APPPORT_URL,
      PORT: "0",
    });
  const startAgent = () =>
    startProcess(
      join(root, "node_modules/.bin/eve"),
      ["start", "--host", "127.0.0.1"],
      agentEnv(),
      /\[START\] server listening at (\S+)/u,
    );

  before(async () => {
    rmSync(join(root, ".eve"), { force: true, recursive: true });
    execFileSync(join(root, "node_modules/.bin/eve"), ["build"], {
      cwd: root,
      env: cleanEnv({ EVE_MODEL_CATALOG: "bundled" }),
      stdio: "ignore",
    });
    agent = await startAgent();
  });

  it("rejects unauthenticated requests", async () => {
    const response = await fetch(new URL("/eve/v1/session", agent.url), { method: "POST" });
    assert.equal(response.status, 401);
  });

  it("answers an authorized question through AppPort and continues after a restart", async () => {
    const before = provenance().length;
    const first = await turn(
      agent.url,
      "alice",
      "Using AppPort, how many units of SKU ALPHA-1 are in stock?",
    );
    assert.match(first.reply, /\b42\b/u);
    const invocations = provenance()
      .slice(before)
      .filter((entry) => entry.capability === "catalog.lookup");
    assert.ok(invocations.some((entry) => entry.success && entry.principal === ALICE));

    await stop(agent.child);
    agent = await startAgent();
    const second = await turn(
      agent.url,
      "alice",
      "And how many units of SKU BETA-2?",
      first.sessionId,
    );
    assert.match(second.reply, /\b7\b/u);
  });

  it("reports AppPort's rejection for a caller without the permission", async () => {
    const before = provenance().length;
    await turn(agent.url, "bob", "Using AppPort, how many units of SKU ALPHA-1 are in stock?");
    const invocations = provenance()
      .slice(before)
      .filter((entry) => entry.capability === "catalog.lookup");
    assert.ok(invocations.length > 0, "the agent did not attempt the invocation");
    assert.ok(invocations.every((entry) => !entry.success && entry.principal === BOB));
  });
});

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB, openAgentState } from "@feltdb/core";

import { AGENT_ID, startInventoryHost } from "../appport-host/host.mjs";
import {
  cleanEnv,
  readJsonl,
  root,
  signJwt,
  startProcess,
  stop,
  stopAll,
  waitFor,
} from "./support.mjs";

const scratch = mkdtempSync(join(tmpdir(), "appport-agent-work-"));
const fixture = join(root, ".acceptance-agent");
const provenanceFile = join(scratch, "provenance.jsonl");
const agentCredentialFile = join(scratch, "agent-credential");
const workDir = join(scratch, "work");
const AGENT_JWT_SECRET = "acceptance-agent-jwt-secret-0123456789abcdef";
const APPPORT_PORT = 4800 + Math.floor(Math.random() * 400);
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const subjectOf = (principalId) => principalId.split(":").at(-1);

const SCRIPTED_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  defaultTools: false,
  model: mockModel({
    modelId: "work-script",
    provider: "acceptance",
    respond: ({ lastUserMessage, toolResults }) => {
      if (String(lastUserMessage).includes("FAIL")) throw new Error("scripted model failure");
      const sku = /SKU (\\S+)/u.exec(String(lastUserMessage))?.[1];
      if (sku === undefined) return "No SKU was given.";
      if (toolResults.length === 0)
        return { toolCalls: [{ name: "appport_invoke", input: { name: "catalog.lookup", input: { sku } } }] };
      return "AppPort answered: " + JSON.stringify(toolResults.at(-1)?.output);
    },
  }),
});
`;

let host;
let agent;
let aliceGrant;

const provenance = () => readJsonl(provenanceFile);

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup",
      APPPORT_AGENT_CREDENTIAL_FILE: agentCredentialFile,
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: `http://127.0.0.1:${APPPORT_PORT}/appport`,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

async function submit(user, key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(user))}`,
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
}

async function read(user, workId) {
  const response = await fetch(new URL(`/work/${workId}`, agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(user))}` },
  });
  return { body: await response.json(), status: response.status };
}

async function settled(user, workId) {
  let work;
  await waitFor(async () => {
    work = (await read(user, workId)).body;
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

before(async () => {
  host = await startInventoryHost({
    adminSecret: "acceptance-authority-admin-secret-0123456789",
    agentCredentialFile,
    dataDir: join(scratch, "host"),
    port: APPPORT_PORT,
    provenanceFile,
  });
  aliceGrant = await host.authority.grant({
    agent: AGENT_ID,
    capabilities: ["catalog.read"],
    delegator: ALICE,
  });
  rmSync(fixture, { force: true, recursive: true });
  cpSync(join(root, "agent"), join(fixture, "agent"), { recursive: true });
  writeFileSync(join(fixture, "agent/agent.ts"), SCRIPTED_AGENT);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      dependencies: { eve: "workspace:*" },
      name: "appport-agent-acceptance",
      private: true,
      type: "module",
    }),
  );
  execFileSync(join(root, "node_modules/.bin/eve"), ["build"], {
    cwd: fixture,
    env: cleanEnv({ EVE_MODEL_CATALOG: "bundled" }),
    stdio: "ignore",
  });
  agent = await startAgent();
});

after(async () => {
  await stopAll();
  await host?.close();
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("durable work in FeltDB (real eve, FeltDB, AppPort and AuthBoundry; scripted model)", () => {
  let alphaWork;

  it("refuses unauthenticated or keyless submissions", async () => {
    const anonymous = await fetch(new URL("/work", agent.url), { body: "{}", method: "POST" });
    assert.equal(anonymous.status, 401);
    assert.equal((await submit(ALICE, undefined, "Look up SKU ALPHA-1")).status, 400);
  });

  it("creates one work record, runs it in an eve session, and records the actual outcome", async () => {
    const { body, status } = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(status, 201);
    assert.equal(body.replayed, false);
    assert.match(body.workId, /^work_[0-9a-f]{32}$/u);
    alphaWork = await settled(ALICE, body.workId);

    assert.deepEqual(alphaWork.invocations, [
      {
        capability: "catalog.lookup",
        errorCode: null,
        ok: true,
        requestId: alphaWork.evidence[0].id,
      },
    ]);
    assert.equal(alphaWork.status, "completed");
    assert.equal(alphaWork.requester, ALICE);
    assert.equal(alphaWork.agent, AGENT_ID);
    assert.equal(alphaWork.objective, "Look up SKU ALPHA-1");
    assert.equal(alphaWork.sessionId, body.sessionId);
    assert.equal(alphaWork.liveSessionId, body.sessionId);
    assert.deepEqual(
      alphaWork.history.map((entry) => entry.status),
      ["ready", "running", "running", "completed"],
    );
    assert.equal(alphaWork.history[2].summary, "AppPort catalog.lookup succeeded.");
    assert.match(alphaWork.summary, /"quantity":42/u);
    assert.equal(alphaWork.evidence.length, 1);
    assert.equal(alphaWork.evidence[0].verified, true);
    assert.equal(alphaWork.evidence[0].collection, "appport_invocations");
  });

  it("links AppPort's own provenance to the work record and Alice's delegation", () => {
    const requestId = alphaWork.evidence[0].id;
    const records = provenance().filter((entry) => entry.requestId === requestId);
    const request = records.find((entry) => entry.kind === "request");
    const decision = records.find((entry) => entry.kind === "authorization");
    assert.equal(request.traceId, alphaWork.workId);
    assert.equal(request.principal, ALICE);
    assert.equal(request.success, true);
    assert.equal(decision.decision, "allow");
    assert.equal(decision.delegationId, aliceGrant.id);
    assert.equal(decision.agent, AGENT_ID);
    assert.deepEqual(decision.authority, {
      application: "inventory",
      kind: "authboundry",
      tenant: "local",
    });
  });

  it("replays a repeated submission instead of creating or running it again", async () => {
    const again = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.workId, alphaWork.workId);
    assert.equal(again.body.sessionId, alphaWork.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await read(ALICE, alphaWork.workId)).body.history.length, 4);

    const conflict = await submit(ALICE, "alpha-1", "Look up SKU BETA-2");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("does not let Bob read Alice's work, and gives Bob's own key its own record", async () => {
    assert.equal((await read(BOB, alphaWork.workId)).status, 404);
    const bobs = await submit(BOB, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(bobs.status, 201);
    assert.notEqual(bobs.body.workId, alphaWork.workId);
    const work = await settled(BOB, bobs.body.workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.decisions, ["waiting: every AppPort invocation was rejected"]);
    assert.equal(work.invocations[0].errorCode, "FORBIDDEN");
    const decision = provenance().find(
      (entry) => entry.requestId === work.evidence[0].id && entry.kind === "authorization",
    );
    assert.equal(decision.reason, "delegation_missing");
  });

  it("does not invoke the capability once Alice revokes her delegation", async () => {
    await host.authority.revoke(aliceGrant.id);
    try {
      const { body } = await submit(ALICE, "after-revoke", "Look up SKU BETA-2");
      const work = await settled(ALICE, body.workId);
      assert.equal(work.status, "blocked");
      const requestId = work.evidence[0].id;
      const records = provenance().filter((entry) => entry.requestId === requestId);
      assert.equal(
        records.find((entry) => entry.kind === "authorization").reason,
        "delegation_revoked",
      );
      assert.equal(
        records.some((entry) => entry.kind === "execution"),
        false,
      );
    } finally {
      aliceGrant = await host.authority.grant({
        agent: AGENT_ID,
        capabilities: ["catalog.read"],
        delegator: ALICE,
      });
    }
  });

  it("records a failed execution as failed work, not as an outcome", async () => {
    const { body } = await submit(ALICE, "fail-1", "Please FAIL while looking up SKU ALPHA-1");
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.decisions, ["failed: the eve turn ended failed"]);
    assert.deepEqual(work.evidence, []);
  });

  it("keeps the work record and its session association across an eve restart", async () => {
    await stop(agent.child);
    agent = await startAgent();
    const after = (await read(ALICE, alphaWork.workId)).body;
    assert.equal(after.status, "completed");
    assert.equal(after.sessionId, alphaWork.sessionId);
    assert.equal(after.liveSessionId, alphaWork.sessionId);
    assert.deepEqual(after.history, alphaWork.history);

    const again = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.sessionId, alphaWork.sessionId);
  });

  it("is authoritative in FeltDB itself, readable without eve", async () => {
    await stop(agent.child);
    const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const state = await openAgentState(db);
    const { tasks } = await state.listTasks({ project: "inventory", limit: 100 });
    assert.equal(tasks.length, 4);
    assert.equal(new Set(tasks.map((task) => task.task_id)).size, 4);

    const { task, checkpoint } = await state.getTask(alphaWork.workId);
    assert.equal(task.status, "completed");
    assert.equal(task.owner, AGENT_ID);
    assert.equal(task.scope.workspace, ALICE);
    assert.equal(checkpoint.version, 4);
    const invocation = await db.collection("appport_invocations").get(checkpoint.evidence[0].id);
    assert.equal(invocation.work_id, alphaWork.workId);
    assert.equal(invocation.caller, ALICE);
    assert.equal(invocation.agent, AGENT_ID);
    assert.equal(invocation.capability, "catalog.lookup");
    assert.equal(invocation.ok, true);
    await db.close?.();
  });
});

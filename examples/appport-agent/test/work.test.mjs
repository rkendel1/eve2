import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB, openAgentState } from "@feltdb/core";

import { AGENT_ID, startInventoryHost } from "../appport-host/host.mjs";
import {
  cleanEnv,
  groupAlive,
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
const OPERATOR = "appport-agent-operator:operator";
const submitted = new Set();
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
      if (String(lastUserMessage).includes("[approval]"))
        return toolResults.length === 0
          ? { toolCalls: [{ name: "await_approval", input: {} }] }
          : "Approved.";
      const sku = /SKU (\\S+)/u.exec(String(lastUserMessage))?.[1];
      if (sku === undefined) return "No SKU was given.";
      if (toolResults.length === 0)
        return { toolCalls: [{ name: "appport_invoke", input: { name: "catalog.lookup", input: { sku } } }] };
      return "AppPort answered: " + JSON.stringify(toolResults.at(-1)?.output);
    },
  }),
});
`;

const FIXTURE_FAULTS = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FaultPoint = "work.accepted" | "invocation.record" | "checkpoint.final";

export interface FaultContext {
  readonly objective: string;
  readonly workId: string;
}

export async function fault(point: FaultPoint, context: FaultContext): Promise<void> {
  const crash = context.objective.includes("[crash:" + point + "]");
  const fail = context.objective.includes("[fail:" + point + "]");
  if (!crash && !fail) return;
  const fired = join(dirname(process.env.APPPORT_AGENT_WORK_DIR ?? "."), "faults-fired");
  mkdirSync(fired, { recursive: true });
  const marker = join(fired, context.workId + "-" + point);
  if (existsSync(marker)) return;
  writeFileSync(marker, new Date().toISOString());
  if (crash) process.kill(process.pid, "SIGKILL");
  throw new Error("injected fault at " + point);
}
`;

const FIXTURE_APPROVAL_TOOL = `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Waits until a person approves.",
  inputSchema: z.object({}),
  async execute() {
    return { approved: true };
  },
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
      APPPORT_AGENT_OPERATOR: OPERATOR,
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: `http://127.0.0.1:${APPPORT_PORT}/appport`,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

const workIdFor = (user, key) =>
  `work_${createHash("sha256").update(`${user}\n${key}`).digest("hex").slice(0, 32)}`;

const lookupsFor = (workId) =>
  provenance().filter(
    (entry) =>
      entry.kind === "request" && entry.capability === "catalog.lookup" && entry.traceId === workId,
  );

async function reachable() {
  try {
    await fetch(agent.url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function restartAgent() {
  await stop(agent.child);
  assert.equal(groupAlive(agent.child.pid), false, "the old eve process group is still alive");
  agent = await startAgent();
}

async function crashThenRestart() {
  await waitFor(async () => !(await reachable()));
  await restartAgent();
}

async function reconcile() {
  const response = await fetch(new URL("/work/reconcile", agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(OPERATOR))}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return (await response.json()).results;
}

async function submit(user, key, objective) {
  if (key !== undefined) submitted.add(workIdFor(user, key));
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
  writeFileSync(join(fixture, "agent/lib/faults.ts"), FIXTURE_FAULTS);
  writeFileSync(join(fixture, "agent/tools/await_approval.ts"), FIXTURE_APPROVAL_TOOL);
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

    assert.equal(alphaWork.invocations.length, 1);
    assert.equal(
      `${alphaWork.workId}.${alphaWork.invocations[0].callId}`,
      alphaWork.evidence[0].id,
    );
    assert.equal(alphaWork.invocations[0].capability, "catalog.lookup");
    assert.equal(alphaWork.invocations[0].ok, true);
    assert.match(alphaWork.invocations[0].requestId, /^eve_/u);
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
    assert.deepEqual(alphaWork.decisions, ["completed after 1 authorized invocation(s)"]);
    assert.equal(alphaWork.evidence.length, 1);
    assert.equal(alphaWork.evidence[0].verified, true);
    assert.equal(alphaWork.evidence[0].collection, "appport_invocations");
  });

  it("links AppPort's own provenance to the work record and Alice's delegation", () => {
    const requestId = alphaWork.invocations[0].requestId;
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
      (entry) =>
        entry.requestId === work.invocations[0].requestId && entry.kind === "authorization",
    );
    assert.equal(decision.reason, "delegation_missing");
  });

  it("does not invoke the capability once Alice revokes her delegation", async () => {
    await host.authority.revoke(aliceGrant.id);
    try {
      const { body } = await submit(ALICE, "after-revoke", "Look up SKU BETA-2");
      const work = await settled(ALICE, body.workId);
      assert.equal(work.status, "blocked");
      const requestId = work.invocations[0].requestId;
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
    await restartAgent();
    const after = (await read(ALICE, alphaWork.workId)).body;
    assert.equal(after.status, "completed");
    assert.equal(after.sessionId, alphaWork.sessionId);
    assert.equal(after.liveSessionId, alphaWork.sessionId);
    assert.deepEqual(after.history, alphaWork.history);

    const again = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.sessionId, alphaWork.sessionId);
  });
});

describe("durable work recovery (process-group crashes and restarts)", () => {
  let waitingWork;

  it("recovers accepted work whose submission crashed before eve started it", async () => {
    const workId = workIdFor(ALICE, "crash-accepted");
    await submit(ALICE, "crash-accepted", "[crash:work.accepted] Look up SKU ALPHA-1").catch(
      () => undefined,
    );
    await crashThenRestart();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.ok(
      work.decisions.includes("recovered: submitted to eve after an interrupted submission"),
    );
    assert.equal(work.sessionId, work.liveSessionId);
    assert.equal(lookupsFor(workId).length, 1);
  });

  it("does not resubmit or claim completion for a turn interrupted after AppPort answered", async () => {
    const { body } = await submit(
      ALICE,
      "crash-mid-turn",
      "[crash:invocation.record] Look up SKU BETA-2",
    );
    await crashThenRestart();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.sessionId, body.sessionId);
    assert.equal(work.liveSessionId, body.sessionId);
    assert.equal(
      work.decisions.some((entry) => entry.startsWith("recovered: submitted")),
      false,
    );
    assert.equal(work.status, "blocked");
    assert.match(
      work.decisions.at(-1),
      /^indeterminate: \d+ AppPort invocation\(s\) without committed evidence$/u,
    );
    assert.equal(lookupsFor(body.workId).length, 2);
    assert.equal(work.invocations.length, 1);
    assert.equal(
      work.decisions.at(-1),
      "indeterminate: 1 AppPort invocation(s) without committed evidence",
    );
  });

  it("reconstructs a completed execution whose final work checkpoint was lost", async () => {
    const { body } = await submit(
      ALICE,
      "crash-final",
      "[crash:checkpoint.final] Look up SKU ALPHA-1",
    );
    await crashThenRestart();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "completed");
    assert.deepEqual(work.decisions.slice(-2), [
      `recovered: final state reconstructed from eve session ${body.sessionId}`,
      "completed after 1 authorized invocation(s)",
    ]);
    assert.equal(work.evidence.length, 1);
    assert.equal(work.evidence[0].verified, true);
    assert.equal(lookupsFor(body.workId).length, 1);
  });

  it("leaves a failed checkpoint write visible until reconciliation, then records only real evidence", async () => {
    const { body } = await submit(
      ALICE,
      "fail-final",
      "[fail:checkpoint.final] Look up SKU ALPHA-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stuck = (await read(ALICE, body.workId)).body;
    assert.equal(stuck.status, "running");
    await reconcile();
    const work = (await read(ALICE, body.workId)).body;
    assert.equal(work.status, "completed");
    assert.equal(
      work.decisions.at(-2),
      `recovered: final state reconstructed from eve session ${body.sessionId}`,
    );
    assert.equal(work.evidence.length, 1);
  });

  it("never cites evidence that was not committed", async () => {
    const { body } = await submit(
      ALICE,
      "fail-evidence",
      "[fail:invocation.record] Look up SKU ALPHA-1",
    );
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.decisions, [
      "indeterminate: 1 AppPort invocation(s) without committed evidence",
    ]);
    assert.deepEqual(work.evidence, []);
    assert.equal(lookupsFor(body.workId).length, 1);
    assert.equal(lookupsFor(body.workId)[0].success, true);
  });

  it("keeps waiting work waiting across a restart", async () => {
    const { body } = await submit(ALICE, "approval", "[approval] Wait for a person");
    await waitFor(async () => (await read(ALICE, body.workId)).body.status === "running");
    await restartAgent();
    waitingWork = await settled(ALICE, body.workId);
    assert.equal(waitingWork.status, "blocked");
    assert.equal(
      waitingWork.decisions.at(-1),
      "waiting: the eve session is waiting for an interaction",
    );
    assert.equal(waitingWork.liveSessionId, body.sessionId);
  });

  it("changes nothing when reconciliation runs again", async () => {
    const before = await Promise.all(
      [...submitted].map(async (workId) => (await read(ALICE, workId)).body),
    );
    const first = await reconcile();
    const second = await reconcile();
    assert.ok(first.every((entry) => entry.action === "unchanged"));
    assert.ok(second.every((entry) => entry.action === "unchanged"));
    const after = await Promise.all(
      [...submitted].map(async (workId) => (await read(ALICE, workId)).body),
    );
    assert.deepEqual(after, before);
  });

  it("stays idempotent for a repeated submission after restarts", async () => {
    const workId = workIdFor(ALICE, "crash-accepted");
    const lookups = lookupsFor(workId).length;
    const again = await submit(
      ALICE,
      "crash-accepted",
      "[crash:work.accepted] Look up SKU ALPHA-1",
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.workId, workId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(lookupsFor(workId).length, lookups);
  });

  it("does not report completion when the eve session is gone", async () => {
    await stop(agent.child);
    const workflowData = join(fixture, ".eve/.workflow-data");
    assert.equal(existsSync(workflowData), true);
    rmSync(workflowData, { force: true, recursive: true });
    agent = await startAgent();
    const work = (await read(ALICE, waitingWork.workId)).body;
    assert.equal(work.status, "blocked");
    assert.equal(
      work.decisions.at(-1),
      `indeterminate: eve session ${waitingWork.sessionId} could not be read`,
    );
  });
});

describe("FeltDB is the authority", () => {
  const alphaWork = { workId: workIdFor(ALICE, "alpha-1") };
  it("is authoritative in FeltDB itself, readable without eve", async () => {
    await stop(agent.child);
    const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const state = await openAgentState(db);
    const { tasks } = await state.listTasks({ project: "inventory", limit: 100 });
    assert.deepEqual(new Set(tasks.map((task) => task.task_id)), submitted);
    assert.equal(tasks.length, submitted.size);
    for (const { task_id: workId } of tasks) {
      const { checkpoint: latest } = await state.getTask(workId);
      for (const cited of latest.evidence) {
        const record = await db.collection(cited.collection).get(cited.id);
        assert.equal(record.work_id, workId, `${workId} cites another work's evidence`);
      }
    }

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

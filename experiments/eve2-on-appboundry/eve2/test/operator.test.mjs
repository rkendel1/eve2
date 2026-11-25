// Isolated tests of the compiled artifact (eve2.app) in FeltKit's reference AppBoundry host.
// The systems here are IN-MEMORY STAND-INS for the providers' contracts, used only to drive every branch of the
// operating model deterministically. They are not Slack, QuickBooks or Claude; the real systems are exercised by
// the experiment run, not by these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createArtifactTestApp } from "@feltdb/feltkit/testing";

const ARTIFACT = fileURLToPath(new URL("../eve2.app", import.meta.url));
const source = { system: "chat", conversation: "C-FIN", message: "1001" };
const POLICY = { operation: "record.bill", requiresApproval: true, approvalReaction: "white_check_mark", approvers: ["U-CFO"], maxAmount: 5000, currency: "USD", reconcileBeforeRetry: true, maxAttempts: 2 };
const REQUEST = "Please enter the Acme Hosting invoice for $480 into QuickBooks. It was approved. Categorize it as hosting expense. Let me know when it's done.";

/** Stand-in systems behind the generic contracts, with fault switches. */
function world() {
  const w = {
    messages: new Map([["1001", { id: "1001", author: { id: "U-ALICE", name: "Alice" }, text: REQUEST, reactions: [], thread: [] }]]),
    replies: [],
    parties: [{ id: "V-56", name: "Acme Hosting" }, { id: "V-57", name: "Globex" }],
    accounts: [{ id: "A-81", name: "Hosting Expense" }, { id: "A-82", name: "Office Supplies" }],
    documents: new Map(),
    byKey: new Map(),
    faults: { createTimeout: 0, tamperGet: false, granted: new Set(["conversation.messages.get", "conversation.messages.reply", "reasoning.interpret", "finance.parties.find", "finance.accounts.find", "finance.documents.find", "finance.documents.create", "finance.documents.get"]) },
    interpretCalls: 0,
    creates: 0,
  };
  const interpret = (text, thread) => {
    w.interpretCalls++;
    const all = `${text}\n${thread}`;
    const amount = /\$(\d+(?:\.\d+)?)/.exec(all);
    const party = /Acme Hosting/.test(all) ? "Acme Hosting" : /Globex/.test(all) ? "Globex" : null;
    const category = /hosting/i.test(all) && /categor|expense/i.test(all) ? "hosting" : null;
    return { kind: /invoice|bill|expense/i.test(all) ? "bill" : null, party, vendorReference: null, amount: amount ? Number(amount[1]) : null, currency: amount ? "USD" : null, category, date: null, description: party ? `${party} services` : null, approvalClaimed: /approved/i.test(all), unclear: [] };
  };
  const ok = (value, key) => ({ outcome: "succeeded", value, outboundId: `out.${key}`, attempt: 1 });
  w.capabilities = {
    list: () => [...w.faults.granted].map(name => ({ name, versions: "1", optional: false, status: "granted", provider: { applicationId: name.split(".")[0], reachable: true }, version: 1 })),
    invoke: ({ name, input, idempotencyKey }) => {
      if (!w.faults.granted.has(name)) return { outcome: "refused", error: { code: "NOT_GRANTED", message: `${name} not granted` } };
      switch (name) {
        case "conversation.messages.get": return ok(structuredClone(w.messages.get(input.message)), idempotencyKey);
        case "conversation.messages.reply": w.replies.push(input.text); return ok({ id: `R${w.replies.length}` }, idempotencyKey);
        case "reasoning.interpret": return ok({ result: interpret(input.request, input.context), usage: { model: "stand-in", inputTokens: 0, outputTokens: 0 } }, idempotencyKey);
        case "finance.parties.find": return ok({ matches: w.parties.filter(p => p.name.toLowerCase() === String(input.name).toLowerCase()) }, idempotencyKey);
        case "finance.accounts.find": return ok({ matches: w.accounts.filter(a => a.name.toLowerCase().startsWith(String(input.name).toLowerCase())) }, idempotencyKey);
        case "finance.documents.find": return ok({ matches: [...w.documents.values()].filter(d => (input.reference === undefined || d.reference === input.reference) && (input.partyId === undefined || d.partyId === input.partyId) && (input.amount === undefined || d.total === input.amount)) }, idempotencyKey);
        case "finance.documents.create": {
          let doc = w.byKey.has(idempotencyKey) ? w.documents.get(w.byKey.get(idempotencyKey)) : null;
          if (!doc) {
            w.creates++;
            doc = { id: `B-${w.documents.size + 100}`, kind: input.kind, reference: input.reference, partyId: input.partyId, total: input.lines.reduce((a, l) => a + l.amount, 0), currency: input.currency, lines: input.lines.map(l => ({ accountId: l.accountId, amount: l.amount })) };
            w.documents.set(doc.id, doc); w.byKey.set(idempotencyKey, doc.id);
          }
          if (w.faults.createTimeout > 0) { w.faults.createTimeout--; return { outcome: "unknown", reason: "No answer from books within 10000 ms; the request may have taken effect.", outboundId: `out.${idempotencyKey}`, attempt: 1 }; }
          return ok(doc, idempotencyKey);
        }
        case "finance.documents.get": {
          const doc = structuredClone(w.documents.get(input.id));
          if (w.faults.tamperGet) doc.total += 100;
          return ok(doc, idempotencyKey);
        }
      }
      return { outcome: "refused", error: { code: "NOT_DECLARED", message: name } };
    },
  };
  return w;
}

async function setup(w) {
  const t = await createArtifactTestApp(ARTIFACT, { capabilities: w.capabilities });
  await t.as("operator").mutation({ name: "tasks:setPolicy" }, POLICY);
  const connector = t.as("source-connector");
  const operator = t.as("operator");
  const drive = async (taskId, max = 40) => {
    for (let i = 0; i < max; i++) {
      const r = await connector.mutation({ name: "tasks:advance" }, { taskId });
      if (r.advanced === false || ["needs_clarification", "needs_approval", "blocked", "completed", "verification_failed", "failed"].includes(r.status)) break;
    }
    return operator.query({ name: "tasks:get" }, { taskId });
  };
  return { t, connector, operator, drive, submit: () => connector.mutation({ name: "tasks:submit" }, { source }) };
}
const approve = (w) => { w.messages.get("1001").reactions = [{ name: "white_check_mark", users: ["U-CFO"] }]; };

test("happy path: interprets, authorizes from a real approval, resolves, records, verifies and reports", async () => {
  const w = world(); approve(w);
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    const { task, evidence, executions } = await drive(taskId);
    assert.equal(task.status, "completed", JSON.stringify(executions.map(e => e.summary), null, 1));
    assert.equal(w.creates, 1);
    assert.deepEqual(evidence.map(e => e.kind).filter((k, i, a) => a.indexOf(k) === i).sort(), ["approval", "model_usage", "source_record", "target_record", "verification"]);
    assert.match(w.replies.at(-1), /^Done: recorded the bill from Acme Hosting for 480.00 USD to Hosting Expense/);
  } finally { await t.close(); }
});

test("missing approval: the text's claim is not approval; Eve stops before execution, and resumes when an approver reacts", async () => {
  const w = world();
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    let r = await drive(taskId);
    assert.equal(r.task.status, "needs_approval");
    assert.match(w.replies.at(-1), /says it was approved, but I need the approval itself/);
    assert.equal(w.creates, 0);
    // A non-approver's reaction does not count; the requester's own does not either.
    w.messages.get("1001").reactions = [{ name: "white_check_mark", users: ["U-ALICE", "U-BOB"] }];
    await submit(); r = await drive(taskId);
    assert.equal(r.task.status, "needs_approval");
    approve(w); await submit(); r = await drive(taskId);
    assert.equal(r.task.status, "completed");
    assert.equal(w.creates, 1);
    assert.equal(w.interpretCalls, 1, "an unchanged request is not re-interpreted");
  } finally { await t.close(); }
});

test("ambiguous request: asks instead of inventing, then completes from the answer in the thread", async () => {
  const w = world(); approve(w);
  w.messages.get("1001").text = "Can you put the usual vendor charge in the books?";
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    let r = await drive(taskId);
    assert.equal(r.task.status, "needs_clarification");
    assert.match(w.replies.at(-1), /who the vendor is; the amount/);
    assert.equal(w.creates, 0);
    w.messages.get("1001").thread = [{ id: "1002", author: { id: "U-ALICE" }, text: "Acme Hosting, $480, categorize as hosting expense." }];
    await submit(); r = await drive(taskId);
    assert.equal(r.task.status, "completed");
  } finally { await t.close(); }
});

test("duplicate delivery: the same request delivered twice is one task and one record", async () => {
  const w = world(); approve(w);
  const { t, submit, drive } = await setup(w);
  try {
    const a = await submit(); const b = await submit();
    assert.equal(a.taskId, b.taskId); assert.equal(b.duplicate, true);
    await drive(a.taskId); await submit(); await drive(a.taskId);
    assert.equal(w.creates, 1);
  } finally { await t.close(); }
});

test("timeout after effect: unknown is reconciled under Eve's reference, not retried blindly", async () => {
  const w = world(); approve(w); w.faults.createTimeout = 1;
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    const { task, executions } = await drive(taskId);
    assert.equal(task.status, "completed");
    assert.equal(w.creates, 1);
    assert.ok(executions.some(e => /did take effect. Not sending it again/.test(e.summary)));
    assert.equal(executions.filter(e => e.capability === "finance.documents.create").length, 1, "create invoked once");
  } finally { await t.close(); }
});

test("target data changed mid-task: an edit after planning is re-evaluated before anything is recorded", async () => {
  const w = world(); approve(w);
  const { t, submit, connector, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    for (let i = 0; i < 20; i++) { const r = await connector.mutation({ name: "tasks:advance" }, { taskId }); if (r.status === "ready") break; }
    w.messages.get("1001").text = REQUEST.replace("$480", "$520");
    const { task, evidence } = await drive(taskId);
    assert.equal(task.status, "completed");
    assert.ok(evidence.some(e => e.kind === "change"));
    assert.equal([...w.documents.values()][0].total, 520);
    assert.equal(w.creates, 1);
  } finally { await t.close(); }
});

test("capability unavailable: Eve names the gap and records nothing", async () => {
  const w = world(); approve(w); w.faults.granted.delete("finance.documents.create");
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    const { task } = await drive(taskId);
    assert.equal(task.status, "blocked");
    assert.match(task.openQuestion, /finance.documents.create is unavailable/);
    assert.equal(w.creates, 0);
  } finally { await t.close(); }
});

test("verification fails: Eve does not claim success", async () => {
  const w = world(); approve(w); w.faults.tamperGet = true;
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    const { task } = await drive(taskId);
    assert.equal(task.status, "verification_failed");
    assert.ok(!w.replies.some(r => r.startsWith("Done")));
    assert.match(w.replies.at(-1), /total differ/);
  } finally { await t.close(); }
});

test("authority: above the policy's limit, or with no policy, Eve does not act", async () => {
  const w = world(); approve(w); w.messages.get("1001").text = REQUEST.replace("$480", "$48000");
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    assert.equal((await drive(taskId)).task.status, "blocked");
    assert.equal(w.creates, 0);
  } finally { await t.close(); }
});

test("existing duplicate in the books: Eve asks instead of entering a second copy", async () => {
  const w = world(); approve(w);
  w.documents.set("B-1", { id: "B-1", kind: "bill", reference: "ACME-0098", partyId: "V-56", total: 480, lines: [{ accountId: "A-81", amount: 480 }] });
  const { t, submit, drive } = await setup(w);
  try {
    const { taskId } = await submit();
    const { task } = await drive(taskId);
    assert.equal(task.status, "needs_clarification");
    assert.match(task.openQuestion, /already have a bill from Acme Hosting for 480.00/);
    assert.equal(w.creates, 0);
  } finally { await t.close(); }
});

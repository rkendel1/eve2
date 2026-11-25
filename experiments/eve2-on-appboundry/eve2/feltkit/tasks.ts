/**
 * The operator. A task advances one step per mutation; each step commits what Eve observed, decided and invoked,
 * then queues the next step after the commit (a host job). A step that waits for a person ends the chain; the source
 * connector resumes it by delivering the change (an approval, an edit, an answer in the thread).
 *
 * Eve never treats a claim as a fact: approval is a reaction by a named approver, a recorded document is one the
 * destination returns, and success is reported only after the destination's own record matches the plan.
 */
import { s } from "@feltdb/feltkit";
import { app, evidence, executions, policies, tasks } from "./app.js";

type Ctx = any;
type Task = { id: string; sourceKey: string; source: { system: string; conversation: string; message: string }; status: string; openQuestion?: string; sourceDigest?: string; intent?: Intent; plan?: Plan; planDigest?: string; reference: string; target?: { id: string; kind: string }; attempts: number; steps: number; createdAt: string; updatedAt: string };
type Message = { id: string; author: { id: string; name?: string }; text: string; editedAt?: string; reactions?: Array<{ name: string; users: string[] }>; thread?: Array<{ id: string; author: { id: string; name?: string }; text: string }> };
type Intent = { kind: string | null; party: string | null; vendorReference: string | null; amount: number | null; currency: string | null; category: string | null; date: string | null; description: string | null; approvalClaimed: boolean; unclear: string[] };
type Plan = { kind: string; partyId: string; partyName: string; accountId: string; accountName: string; amount: number; currency: string; date: string | null; description: string; reference: string; vendorReference: string | null; memo: string };
type Policy = { operation: string; requiresApproval: boolean; approvalReaction: string; approvers: string[]; maxAmount: number; currency: string; reconcileBeforeRetry: boolean; maxAttempts: number };

const WAITING = new Set(["needs_clarification", "needs_approval", "blocked", "failed", "verification_failed"]);
const TERMINAL = new Set(["completed"]);
const MAX_STEPS = 60;
const now = () => new Date().toISOString();

/** FNV-1a over canonical JSON, twice with different seeds: a stable 64-bit digest the guest computes without crypto. */
function digest(value: unknown): string {
  const text = canonical(value);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
}
const money = (n: number) => n.toFixed(2);

/* ------------------------------------------------------------------ submit: a source delivers a request or a change */

export const submit = app.mutation({
  access: "tasks.submit",
  args: { source: s.object({ system: s.string(), conversation: s.string(), message: s.string() }) },
  handler: async (ctx: Ctx, { source }: { source: Task["source"] }) => {
    const sourceKey = `${source.system}:${source.conversation}:${source.message}`;
    const [existing] = (await ctx.db.find(tasks, { sourceKey })) as Task[];
    if (existing) {
      // A duplicate delivery of a request Eve already owns adds nothing; a change to a waiting task resumes it.
      if (WAITING.has(existing.status) && existing.status !== "failed") {
        await ctx.db.patch(tasks, existing.id, { status: "received", openQuestion: undefined, updatedAt: now() });
        await record(ctx, existing, "observe", existing.status, "received", "The source delivered a change; re-evaluating the request.");
        ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: existing.id }, { maxAttempts: 3 });
        return { taskId: existing.id, status: "received", resumed: true };
      }
      return { taskId: existing.id, status: existing.status, duplicate: true };
    }
    const at = now();
    const reference = `EVE-${digest(sourceKey).slice(0, 12).toUpperCase()}`;
    const id = await ctx.db.insert(tasks, { sourceKey, source, status: "received", reference, attempts: 0, steps: 0, createdAt: at, updatedAt: at });
    await ctx.db.insert(executions, { taskId: id, seq: 0, at, from: "", to: "received", kind: "observe", summary: `Took responsibility for ${sourceKey}.` });
    ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: id }, { maxAttempts: 3 });
    return { taskId: id, status: "received" };
  },
});

/* ------------------------------------------------------------------ advance: one step of the operating model */

export const advance = app.mutation({
  access: "tasks.advance",
  args: { taskId: s.string() },
  handler: async (ctx: Ctx, { taskId }: { taskId: string }) => {
    const task = (await ctx.db.get(tasks, taskId)) as Task | null;
    if (!task || WAITING.has(task.status) || TERMINAL.has(task.status)) return { taskId, status: task?.status ?? "missing", advanced: false };
    if (task.steps >= MAX_STEPS) return halt(ctx, task, "blocked", `I stopped after ${MAX_STEPS} steps without finishing; an operator needs to look at this task.`);
    const run = STEPS[task.status];
    if (!run) return halt(ctx, task, "blocked", `Unknown status ${task.status}.`);
    return run(ctx, task);
  },
});

const STEPS: Record<string, (ctx: Ctx, task: Task) => Promise<unknown>> = {
  received: interpret,
  authorizing: authorize,
  resolving: resolve,
  ready: execute,
  reconciling: reconcile,
  verifying: verify,
  reporting: report,
};

/** Read the request and its thread; interpret it only if it changed since the last interpretation. */
async function interpret(ctx: Ctx, task: Task) {
  const read = await invoke(ctx, task, "conversation.messages.get", { conversation: task.source.conversation, message: task.source.message }, `${task.id}:read:${task.steps}`);
  if (read.outcome !== "succeeded") return unavailable(ctx, task, "conversation.messages.get", read);
  const message = read.value as Message;
  const sourceDigest = digest({ text: message.text, thread: (message.thread ?? []).map((m) => [m.author.id, m.text]) });
  await keep(ctx, task, "source_record", message);
  if (task.intent && task.sourceDigest === sourceDigest) return move(ctx, task, "authorizing", "decide", "The request is unchanged since it was interpreted.");

  const thread = (message.thread ?? []).map((m) => `${m.author.name ?? m.author.id}: ${m.text}`).join("\n");
  const asked = await invoke(ctx, task, "reasoning.interpret", {
    instructions: INTERPRET,
    request: message.text,
    context: thread ? `Replies in the thread, oldest first:\n${thread}` : "",
    schema: INTENT_SCHEMA,
  }, `${task.id}:interpret:${sourceDigest}`);
  if (asked.outcome !== "succeeded") return unavailable(ctx, task, "reasoning.interpret", asked);
  const { result, usage } = asked.value as { result: Intent; usage?: unknown };
  if (usage) await keep(ctx, task, "model_usage", usage);
  const intent = normalize(result);
  const missing = [
    ...(intent.kind === null ? ["what kind of record this is (a vendor bill?)"] : []),
    ...(intent.party === null ? ["who the vendor is"] : []),
    ...(intent.amount === null ? ["the amount"] : []),
    ...(intent.currency === null ? ["the currency"] : []),
    ...(intent.category === null ? ["which expense category to use"] : []),
    ...intent.unclear,
  ];
  await ctx.db.patch(tasks, task.id, { intent, sourceDigest });
  if (missing.length) return wait(ctx, task, "needs_clarification", `Before I enter this I need: ${missing.join("; ")}. Reply in this thread and I will pick it up.`, { intent });
  return move(ctx, task, "authorizing", "decide", `Interpreted as a ${intent.kind} from ${intent.party} for ${money(intent.amount!)} ${intent.currency}, category ${intent.category}.`, { intent });
}

/** Authority: a policy for the operation, an amount within it, and an approval that exists in the source system. */
async function authorize(ctx: Ctx, task: Task) {
  const intent = task.intent!;
  const operation = `record.${intent.kind}`;
  const [policy] = (await ctx.db.find(policies, { operation })) as Policy[];
  if (!policy) return wait(ctx, task, "blocked", `I have no policy that lets me ${operation.replace(".", " a ")}; an operator has to grant it before I act.`);
  if (intent.currency !== policy.currency) return wait(ctx, task, "needs_clarification", `This is in ${intent.currency}, and I may only record ${policy.currency}.`);
  if (intent.amount! > policy.maxAmount) return wait(ctx, task, "blocked", `${money(intent.amount!)} ${intent.currency} is above the ${money(policy.maxAmount)} I may record on my own; a person needs to enter this one.`);
  if (policy.requiresApproval) {
    const source = await latest(ctx, task, "source_record");
    const reaction = (source?.reactions ?? []).find((r: { name: string }) => r.name === policy.approvalReaction);
    const approvers = (reaction?.users ?? []).filter((u: string) => policy.approvers.includes(u) && u !== source?.author?.id);
    if (!approvers.length) {
      const claimed = intent.approvalClaimed ? " The message says it was approved, but I need the approval itself." : "";
      return wait(ctx, task, "needs_approval", `This needs approval before I enter it.${claimed} An approver (${policy.approvers.map((a) => `<@${a}>`).join(", ")}) can react with :${policy.approvalReaction}: on the request.`);
    }
    await keep(ctx, task, "approval", { reaction: policy.approvalReaction, approvers, policy: policy.operation });
  }
  return move(ctx, task, "resolving", "decide", `Authorized under policy ${operation}${policy.requiresApproval ? " with an approval in the source" : ""}.`);
}

/** Discover the destination, resolve the names to its records, and rule out a duplicate. */
async function resolve(ctx: Ctx, task: Task) {
  const intent = task.intent!;
  const listed = (await ctx.capabilities.list()) as Array<{ name: string; status: string; provider?: { applicationId: string; reachable: boolean } }>;
  const needed = ["finance.parties.find", "finance.accounts.find", "finance.documents.find", "finance.documents.create", "finance.documents.get"];
  const gaps = needed.map((n) => listed.find((l) => l.name === n) ?? { name: n, status: "unavailable" }).filter((l) => l.status !== "granted" || l.provider?.reachable === false);
  await record(ctx, task, "observe", task.status, task.status, `Discovered ${listed.length} capabilities; ${gaps.length ? `${gaps.length} missing` : "all needed are granted"}.`, { listed: listed.map((l) => [l.name, l.status, l.provider?.reachable ?? null]) });
  if (gaps.length) return wait(ctx, task, "blocked", `I can't do this yet: ${gaps.map((g) => `${g.name} is ${g.status === "granted" ? "unreachable" : g.status}`).join("; ")}. Nothing was entered.`);

  const party = await invoke(ctx, task, "finance.parties.find", { name: intent.party, role: "vendor" }, `${task.id}:party:${task.planDigest ?? task.sourceDigest}`);
  if (party.outcome !== "succeeded") return unavailable(ctx, task, "finance.parties.find", party);
  const parties = (party.value as { matches: Array<{ id: string; name: string }> }).matches;
  if (parties.length !== 1) return wait(ctx, task, "needs_clarification", parties.length ? `"${intent.party}" matches ${parties.length} vendors (${parties.map((p) => p.name).join(", ")}); which one?` : `I can't find a vendor named "${intent.party}" in the books. Should it be created by someone, or is it listed under another name?`);
  const account = await invoke(ctx, task, "finance.accounts.find", { name: intent.category, purpose: "expense" }, `${task.id}:account:${task.planDigest ?? task.sourceDigest}`);
  if (account.outcome !== "succeeded") return unavailable(ctx, task, "finance.accounts.find", account);
  const accounts = (account.value as { matches: Array<{ id: string; name: string }> }).matches;
  if (accounts.length !== 1) return wait(ctx, task, "needs_clarification", accounts.length ? `"${intent.category}" matches ${accounts.length} accounts (${accounts.map((a) => a.name).join(", ")}); which one?` : `I can't find an expense account for "${intent.category}". Which account should this go to?`);

  // Eve's own reference first: if it is there, an earlier attempt already recorded it.
  const mine = await invoke(ctx, task, "finance.documents.find", { kind: intent.kind, reference: task.reference }, `${task.id}:find-own:${task.steps}`);
  if (mine.outcome !== "succeeded") return unavailable(ctx, task, "finance.documents.find", mine);
  const own = (mine.value as { matches: Array<{ id: string }> }).matches;
  if (own.length) {
    await keep(ctx, task, "duplicate", { reason: "already recorded under Eve's reference", matches: own });
    await ctx.db.patch(tasks, task.id, { target: { id: own[0]!.id, kind: intent.kind } });
    return move(ctx, task, "verifying", "decide", `Already recorded as ${own[0]!.id} under ${task.reference}; verifying instead of entering it again.`);
  }
  // Someone else's copy of the same bill: same vendor and amount (and vendor reference, when given).
  const others = await invoke(ctx, task, "finance.documents.find", { kind: intent.kind, partyId: parties[0]!.id, amount: intent.amount, ...(intent.vendorReference ? { vendorReference: intent.vendorReference } : {}) }, `${task.id}:find-dup:${task.steps}`);
  if (others.outcome !== "succeeded") return unavailable(ctx, task, "finance.documents.find", others);
  const dupes = (others.value as { matches: Array<{ id: string; reference?: string; date?: string }> }).matches;
  if (dupes.length) {
    await keep(ctx, task, "duplicate", { reason: "same vendor and amount", matches: dupes });
    return wait(ctx, task, "needs_clarification", `The books already have ${dupes.length === 1 ? "a" : dupes.length} ${intent.kind} from ${parties[0]!.name} for ${money(intent.amount!)} (${dupes.map((d) => `${d.reference ?? d.id}${d.date ? ` on ${d.date}` : ""}`).join(", ")}). Is this a different one? Reply "yes, it's new" with its invoice number and I will enter it.`);
  }
  const plan: Plan = {
    kind: intent.kind!, partyId: parties[0]!.id, partyName: parties[0]!.name, accountId: accounts[0]!.id, accountName: accounts[0]!.name,
    amount: intent.amount!, currency: intent.currency!, date: intent.date, description: intent.description ?? `${intent.party} ${intent.category}`,
    reference: task.reference, vendorReference: intent.vendorReference,
    memo: `Recorded by Eve from ${task.sourceKey}`,
  };
  const planDigest = digest(plan);
  await ctx.db.patch(tasks, task.id, { plan, planDigest });
  return move(ctx, task, "ready", "decide", `Plan: ${plan.kind} from ${plan.partyName} (${plan.partyId}) for ${money(plan.amount)} ${plan.currency} to ${plan.accountName} (${plan.accountId}), reference ${plan.reference}.`, { plan, planDigest });
}

/** Re-check the source, then perform the operation. An uncertain outcome is reconciled, never assumed. */
async function execute(ctx: Ctx, task: Task) {
  const read = await invoke(ctx, task, "conversation.messages.get", { conversation: task.source.conversation, message: task.source.message }, `${task.id}:recheck:${task.steps}`);
  if (read.outcome !== "succeeded") return unavailable(ctx, task, "conversation.messages.get", read);
  const message = read.value as Message;
  const current = digest({ text: message.text, thread: (message.thread ?? []).map((m) => [m.author.id, m.text]) });
  if (current !== task.sourceDigest) {
    await keep(ctx, task, "change", { before: task.sourceDigest, after: current, text: message.text });
    return move(ctx, task, "received", "observe", "The request changed after I planned it; re-evaluating before doing anything.");
  }
  await keep(ctx, task, "source_record", message);
  const [policy] = (await ctx.db.find(policies, { operation: `record.${task.plan!.kind}` })) as Policy[];
  if (policy?.requiresApproval) {
    const reaction = (message.reactions ?? []).find((r) => r.name === policy.approvalReaction);
    if (!(reaction?.users ?? []).some((u) => policy.approvers.includes(u) && u !== message.author.id)) return move(ctx, task, "authorizing", "observe", "The approval is no longer on the request; checking authority again.");
  }
  if (task.attempts >= (policy?.maxAttempts ?? 2)) return halt(ctx, task, "failed", `I tried ${task.attempts} times and could not confirm the ${task.plan!.kind} was recorded; I have stopped so nothing is entered twice.`);
  const plan = task.plan!;
  await ctx.db.patch(tasks, task.id, { attempts: task.attempts + 1 });
  const created = await invoke(ctx, task, "finance.documents.create", {
    kind: plan.kind, partyId: plan.partyId, reference: plan.reference, ...(plan.vendorReference ? { vendorReference: plan.vendorReference } : {}), ...(plan.date ? { date: plan.date } : {}),
    currency: plan.currency, memo: plan.memo, lines: [{ accountId: plan.accountId, amount: plan.amount, description: plan.description }],
  }, `${task.id}:create:${task.planDigest}`);
  if (created.outcome === "succeeded") {
    await ctx.db.patch(tasks, task.id, { target: { id: (created.value as { id: string }).id, kind: plan.kind } });
    return move(ctx, task, "verifying", "invoke", `The destination answered with ${(created.value as { id: string }).id}; verifying it independently.`);
  }
  if (created.outcome === "unknown") return move(ctx, task, "reconciling", "invoke", `No answer from the destination (${created.reason}); it may have been recorded. Reconciling before deciding anything.`);
  if (created.outcome === "refused") return unavailable(ctx, task, "finance.documents.create", created);
  return halt(ctx, task, "failed", `The destination refused the ${plan.kind}: ${created.error.message}. Nothing was recorded.`);
}

/** After an unknown outcome: look for the document under Eve's reference before anything else. */
async function reconcile(ctx: Ctx, task: Task) {
  const found = await invoke(ctx, task, "finance.documents.find", { kind: task.plan!.kind, reference: task.reference }, `${task.id}:reconcile:${task.steps}`);
  if (found.outcome !== "succeeded") {
    await record(ctx, task, "wait", task.status, task.status, "Could not reach the destination to reconcile; trying again shortly.");
    ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3, runAt: new Date(Date.now() + 5_000).toISOString() });
    return { taskId: task.id, status: task.status };
  }
  const matches = (found.value as { matches: Array<{ id: string }> }).matches;
  if (matches.length) {
    await ctx.db.patch(tasks, task.id, { target: { id: matches[0]!.id, kind: task.plan!.kind } });
    return move(ctx, task, "verifying", "decide", `Reconciled: the destination has ${matches[0]!.id} under ${task.reference}; the earlier request did take effect. Not sending it again.`);
  }
  return move(ctx, task, "ready", "decide", `Reconciled: nothing under ${task.reference}, so the earlier request did not take effect; sending it again with the same idempotency key is safe.`);
}

/** Read the document back from the destination and compare it with the plan. */
async function verify(ctx: Ctx, task: Task) {
  const plan = task.plan!;
  const got = await invoke(ctx, task, "finance.documents.get", { kind: task.target!.kind, id: task.target!.id }, `${task.id}:verify:${task.steps}`);
  if (got.outcome !== "succeeded") return unavailable(ctx, task, "finance.documents.get", got);
  const doc = got.value as { id: string; reference?: string; partyId: string; total: number; currency?: string; lines: Array<{ accountId: string; amount: number }> };
  await keep(ctx, task, "target_record", doc);
  const checks = {
    reference: doc.reference === plan.reference,
    party: doc.partyId === plan.partyId,
    total: Math.abs(doc.total - plan.amount) < 0.005,
    account: doc.lines.length === 1 && doc.lines[0]!.accountId === plan.accountId && Math.abs(doc.lines[0]!.amount - plan.amount) < 0.005,
    currency: !doc.currency || doc.currency === plan.currency,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  await keep(ctx, task, "verification", { checks, documentId: doc.id });
  if (failed.length) return halt(ctx, task, "verification_failed", `The ${plan.kind} the books show as ${doc.id} does not match what was asked (${failed.join(", ")} differ). I am not reporting this as done; it needs a person.`);
  return move(ctx, task, "reporting", "verify", `Verified ${doc.id}: reference, vendor, total and account match the plan.`);
}

/** Tell the requester, where they asked, what actually happened. */
async function report(ctx: Ctx, task: Task) {
  const plan = task.plan!;
  const replied = await invoke(ctx, task, "conversation.messages.reply", {
    conversation: task.source.conversation, message: task.source.message,
    text: `Done: recorded the ${plan.kind} from ${plan.partyName} for ${money(plan.amount)} ${plan.currency} to ${plan.accountName} (${task.target!.id}, reference ${plan.reference}). I read it back from the books and it matches. Task ${task.id}.`,
  }, `${task.id}:report`);
  if (replied.outcome !== "succeeded") {
    await record(ctx, task, "wait", task.status, task.status, "The report could not be posted yet; retrying shortly. The record itself is verified.");
    ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3, runAt: new Date(Date.now() + 5_000).toISOString() });
    return { taskId: task.id, status: task.status };
  }
  return move(ctx, task, "completed", "report", "Reported the verified outcome in the source.");
}

/* ------------------------------------------------------------------ helpers: every effect leaves a record */

async function invoke(ctx: Ctx, task: Task, capability: string, input: unknown, idempotencyKey: string) {
  const result = await ctx.capabilities.invoke(capability, input, { idempotencyKey });
  const summary = result.outcome === "succeeded" ? `${capability} succeeded${result.replayed ? " (replayed)" : ""}`
    : result.outcome === "unknown" ? `${capability}: outcome unknown (${result.reason})`
    : `${capability} ${result.outcome}: ${result.error.code} ${result.error.message}`;
  await ctx.db.insert(executions, {
    taskId: task.id, seq: task.steps, at: now(), from: task.status, to: task.status, kind: "invoke", summary, capability, idempotencyKey, outcome: result.outcome,
    ...(result.outboundId ? { outboundId: result.outboundId } : {}),
    ...(result.outcome === "failed" || result.outcome === "refused" ? { detail: result.error } : {}),
  });
  return result;
}

async function record(ctx: Ctx, task: Task, kind: string, from: string, to: string, summary: string, detail?: unknown) {
  await ctx.db.insert(executions, { taskId: task.id, seq: task.steps, at: now(), from, to, kind, summary, ...(detail !== undefined ? { detail } : {}) });
}

async function keep(ctx: Ctx, task: Task, kind: string, data: unknown) {
  await ctx.db.insert(evidence, { taskId: task.id, kind, at: now(), digest: digest(data), data });
}

async function latest(ctx: Ctx, task: Task, kind: string) {
  const rows = (await ctx.db.find(evidence, { taskId: task.id, kind })) as Array<{ at: string; data: any }>;
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]?.data ?? null;
}

async function move(ctx: Ctx, task: Task, to: string, kind: string, summary: string, detail?: unknown) {
  await record(ctx, task, kind, task.status, to, summary, detail);
  await ctx.db.patch(tasks, task.id, { status: to, steps: task.steps + 1, updatedAt: now(), openQuestion: undefined });
  ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3 });
  return { taskId: task.id, status: to };
}

/** Stop and ask (or explain), in the source, where the person who asked will see it. Eve keeps the task. */
async function wait(ctx: Ctx, task: Task, to: string, question: string, detail?: unknown) {
  await record(ctx, task, "wait", task.status, to, question, detail);
  await ctx.db.patch(tasks, task.id, { status: to, openQuestion: question, steps: task.steps + 1, updatedAt: now() });
  await invoke(ctx, { ...task, steps: task.steps + 1 }, "conversation.messages.reply", { conversation: task.source.conversation, message: task.source.message, text: question }, `${task.id}:ask:${task.steps}`);
  return { taskId: task.id, status: to, question };
}

const halt = (ctx: Ctx, task: Task, to: string, why: string) => wait(ctx, task, to, why);

/** A capability that did not answer usefully: say exactly which, and keep the task. */
function unavailable(ctx: Ctx, task: Task, capability: string, result: any) {
  const why = result.outcome === "unknown" ? `it did not answer (${result.reason})` : `${result.error.code}: ${result.error.message}`;
  return wait(ctx, task, "blocked", `I couldn't use ${capability}: ${why}. Nothing was entered; I'll continue when it is available.`);
}

function normalize(raw: Partial<Intent> | null | undefined): Intent {
  const r = raw ?? {};
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const amount = typeof r.amount === "number" && Number.isFinite(r.amount) && r.amount > 0 ? Math.round(r.amount * 100) / 100 : null;
  const kind = text(r.kind)?.toLowerCase() ?? null;
  return {
    kind: kind === "bill" || kind === "invoice" ? kind : null,
    party: text(r.party), vendorReference: text(r.vendorReference), amount, currency: text(r.currency)?.toUpperCase() ?? null,
    category: text(r.category), date: text(r.date) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? String(r.date) : null, description: text(r.description),
    approvalClaimed: r.approvalClaimed === true, unclear: Array.isArray(r.unclear) ? r.unclear.filter((u): u is string => typeof u === "string" && u.trim().length > 0) : [],
  };
}

const INTERPRET = [
  "You read a request someone posted for a finance operator and extract what they asked for. Return only what the request and its thread state;",
  "never guess a value that is not there. Use null for anything not stated.",
  "kind: \"bill\" when the company owes a vendor (an invoice it received, an expense to record), \"invoice\" when the company bills a customer.",
  "party: the vendor or customer name as written. vendorReference: the vendor's invoice number, if given. amount: a number. currency: ISO code; \"$\" alone means USD.",
  "category: the expense or income category as written (e.g. \"hosting\"). date: YYYY-MM-DD if a date is stated. description: a short line for the record.",
  "approvalClaimed: true if the text says it was approved (this is only a claim; approval is verified elsewhere, so never ask about it).",
  "unclear: only questions without whose answer the record cannot be entered correctly: a missing or contradictory vendor, amount or category, or an ambiguous reference such as \"the usual\".",
  "Do not list optional details (invoice number, date, due date, terms) or approval in unclear; leave them null when not stated.",
].join(" ");

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    kind: nullable({ type: "string", enum: ["bill", "invoice"] }), party: nullable({ type: "string" }), vendorReference: nullable({ type: "string" }),
    amount: nullable({ type: "number" }), currency: nullable({ type: "string" }), category: nullable({ type: "string" }), date: nullable({ type: "string" }),
    description: nullable({ type: "string" }), approvalClaimed: { type: "boolean" }, unclear: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "party", "vendorReference", "amount", "currency", "category", "date", "description", "approvalClaimed", "unclear"],
  additionalProperties: false,
};

/* ------------------------------------------------------------------ reading and operating */

export const get = app.query({ access: "tasks.read", args: { taskId: s.string() }, handler: async (ctx: Ctx, { taskId }: { taskId: string }) => ({
  task: await ctx.db.get(tasks, taskId),
  executions: ((await ctx.db.find(executions, { taskId })) as Array<{ at: string }>).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  evidence: ((await ctx.db.find(evidence, { taskId })) as Array<{ at: string }>).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
}) });

export const list = app.query({ access: "tasks.read", handler: (ctx: Ctx) => ctx.db.find(tasks) });

export const capabilities = app.query({ access: "tasks.read", handler: (ctx: Ctx) => ctx.capabilities.list() });

export const setPolicy = app.mutation({
  access: "policies.write",
  args: { operation: s.string(), requiresApproval: s.boolean(), approvalReaction: s.string(), approvers: s.array(s.string()), maxAmount: s.number(), currency: s.string(), reconcileBeforeRetry: s.boolean(), maxAttempts: s.number() },
  handler: async (ctx: Ctx, policy: Policy) => {
    const [existing] = (await ctx.db.find(policies, { operation: policy.operation })) as Array<{ id: string }>;
    if (existing) await ctx.db.replace(policies, existing.id, policy);
    else await ctx.db.insert(policies, policy);
    return policy;
  },
});

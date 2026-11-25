/**
 * Work on code and work items, through neutral contracts (tracker.items.*, code.workspace.*, code.changes.*).
 *
 *   assess   investigate a repository; substantiate each finding with source evidence and a failing test Eve wrote and
 *            checkpointed; prove it (the quoted lines are there, the test fails on the unmodified code for a behavioral
 *            reason, not a load error); file only proven findings, exactly once, read each issue back; then start a
 *            resolution linked to it
 *   resolve  take a work item to a proposed change in a working copy seeded with the reproduction; pass Eve's gate (a
 *            bounded diff with a test; every named test passes on the exact checkpointed revision; the new tests fail on
 *            the base); publish for review exactly once (never merge); read it back; report on the item
 *
 * Durability. Eve's state (FeltDB) is the record; the provider is disposable:
 *   - every file Eve writes is checkpointed here (content by SHA-256 in `blobs`, path → digest and the provider's tree in
 *     the task), so a lost working copy is rebuilt from the base commit and the checkpoint, and must come back at the
 *     same tree
 *   - a check result is bound to the tree it ran on; a run lost with the provider is run again
 *   - every external effect carries an operation marker; an unknown outcome is reconciled with the system before
 *     anything is sent again
 */
import { s } from "@feltdb/feltkit";
import { app, blobs, evidence, policies, tasks } from "./app.js";
import { digest, halt, invoke, keep, move, notify, now, record, unavailable, type Ctx, type Task } from "./_ops.js";
import { sha256 } from "./_sha256.js";

type Limits = { repositories?: string[]; maxDecisions?: number; maxIssues?: number; maxFiles?: number; forbiddenPaths?: string[]; maxGateAttempts?: number; autoResolve?: boolean };
type Evidence = { kind: "code"; path: string; startLine: number; endLine: number; quote: string } | { kind: "check"; check: string; target: string; expect: "fails" };
type Finding = { title: string; severity: "high" | "medium" | "low"; summary: string; evidence: Evidence[]; fix: string };
const SEVERITY = { high: 0, medium: 1, low: 2 } as const;
const OBSERVATION_CHARS = 3500;
const OBSERVATIONS_KEPT = 40;
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/;

/* ------------------------------------------------------------------ assign: an operator gives Eve work */

export const assign = app.mutation({
  access: "tasks.assign",
  args: { operation: s.enum(["assess", "resolve"] as const), repository: s.string(), item: s.optional(s.number()), objective: s.optional(s.string()), assignment: s.string() },
  handler: async (ctx: Ctx, a: { operation: "assess" | "resolve"; repository: string; item?: number; objective?: string; assignment: string }) => {
    if (a.operation === "resolve" && !a.item) throw new Error("resolve needs the work item's number.");
    const source = a.operation === "resolve" ? { system: "tracker", conversation: a.repository, message: String(a.item) } : { system: "operator", conversation: a.repository, message: a.assignment };
    return createTask(ctx, a.operation, source, { objective: a.objective ?? null });
  },
});

/** One task per source: a second delivery of the same source is the same task. */
async function createTask(ctx: Ctx, operation: string, source: Task["source"], work: Record<string, unknown>) {
  const sourceKey = `${source.system}:${source.conversation}:${source.message}`;
  const [existing] = (await ctx.db.find(tasks, { sourceKey })) as Task[];
  if (existing) return { taskId: existing.id, status: existing.status, duplicate: true };
  const at = now();
  const id = await ctx.db.insert(tasks, {
    sourceKey, source, operation, status: "received", reference: `EVE-${digest(sourceKey).slice(0, 12).toUpperCase()}`, attempts: 0, steps: 0,
    work: { decisions: 0, gateAttempts: 0, restores: 0, ...work }, createdAt: at, updatedAt: at,
  });
  ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: id }, { maxAttempts: 3 });
  return { taskId: id, status: "received" };
}

/* ------------------------------------------------------------------ policy, state, checkpoints */

async function policyFor(ctx: Ctx, task: Task): Promise<Limits | null> {
  const [policy] = (await ctx.db.find(policies, { operation: `${task.operation}.repository` })) as Array<{ limits?: Limits }>;
  const limits = policy?.limits ?? {};
  return policy && limits.repositories?.includes(task.source.conversation) ? limits : null;
}

/** Successive patches in one step build on each other: the task's working state is updated in place, then written. */
const patchWork = (ctx: Ctx, task: Task, work: Record<string, unknown>) => {
  task.work = { ...task.work, ...work };
  return ctx.db.patch(tasks, task.id, { work: task.work, updatedAt: now() });
};
const later = (ctx: Ctx, task: Task, ms: number) => ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3, ...(ms ? { runAt: new Date(Date.now() + ms).toISOString() } : {}) });
const stay = async (ctx: Ctx, task: Task, ms: number) => { await ctx.db.patch(tasks, task.id, { steps: task.steps + 1, updatedAt: now() }); later(ctx, task, ms); return { taskId: task.id, status: task.status }; };
const workspaceName = (task: Task) => `eve-${task.id}`;
const repo = (task: Task) => task.source.conversation;

async function saveBlob(ctx: Ctx, content: string): Promise<string> {
  const hash = sha256(content);
  const [existing] = await ctx.db.find(blobs, { sha256: hash });
  if (!existing) await ctx.db.insert(blobs, { sha256: hash, content });
  return hash;
}

/** Record a file Eve wrote: its content (by digest) and the provider's tree after the write. One checkpoint per write. */
async function checkpoint(ctx: Ctx, task: Task, path: string, content: string, tree: string) {
  const hash = await saveBlob(ctx, content);
  const cp = task.work.checkpoint ?? { files: {}, seq: 0 };
  const next = { files: { ...cp.files, [path]: hash }, tree, seq: cp.seq + 1, at: now() };
  await patchWork(ctx, task, { checkpoint: next });
  await keep(ctx, task, "checkpoint", { seq: next.seq, path, sha256: hash, tree, files: Object.keys(next.files).length });
}

async function checkpointFiles(ctx: Ctx, task: Task): Promise<Array<{ path: string; content: string }>> {
  const files = Object.entries((task.work.checkpoint?.files ?? {}) as Record<string, string>);
  const out: Array<{ path: string; content: string }> = [];
  for (const [path, hash] of files) {
    const [blob] = (await ctx.db.find(blobs, { sha256: hash })) as Array<{ content: string }>;
    if (!blob || sha256(blob.content) !== hash) throw new Error(`checkpoint blob ${hash} for ${path} is missing or corrupt`);
    out.push({ path, content: blob.content });
  }
  return out;
}

const gone = (r: any) => r.outcome === "failed" && r.error?.code === "NOT_FOUND" && /is not open in this provider process/.test(r.error.message);
const runLost = (r: any) => r.outcome === "failed" && r.error?.code === "NOT_FOUND" && /is not known to this provider process/.test(r.error.message);

/** Rebuild the working copy from the base commit and the checkpoint; it must come back at the checkpointed tree. */
async function restore(ctx: Ctx, task: Task, why: string): Promise<boolean> {
  const files = await checkpointFiles(ctx, task);
  const n = (task.work.restores ?? 0) + 1;
  const opened = await invoke(ctx, task, "code.workspace.open", { repository: repo(task), workspace: workspaceName(task), sha: task.work.sha, files }, `${task.id}:restore:${n}`);
  if (opened.outcome !== "succeeded") { await unavailable(ctx, task, "code.workspace.open", opened); return false; }
  const v = opened.value as { tree: string; sha: string };
  const expected = task.work.checkpoint?.tree ?? null;
  const matches = expected === null || v.tree === expected;
  await keep(ctx, task, "recovery", { why, restore: n, base: v.sha, files: files.map((f) => f.path), tree: v.tree, expectedTree: expected, matches });
  await record(ctx, task, "recover", task.status, task.status, `${why}; rebuilt the working copy from ${String(task.work.sha).slice(0, 12)} and ${files.length} checkpointed file(s): tree ${matches ? "matches" : "DIFFERS"}.`);
  await patchWork(ctx, task, { restores: n });
  if (!matches) { await halt(ctx, task, "blocked", `The rebuilt working copy is at tree ${v.tree.slice(0, 12)}, not the checkpointed ${String(expected).slice(0, 12)}; I stopped rather than continue on different content.`); return false; }
  return true;
}

/** A workspace operation; a working copy the provider no longer has is rebuilt from the checkpoint, then asked again. */
async function ws(ctx: Ctx, task: Task, capability: string, input: Record<string, unknown>, key: string): Promise<any | null> {
  const call = { ...input, workspace: workspaceName(task) };
  let r = await invoke(ctx, task, capability, call, key);
  if (gone(r)) {
    if (!(await restore(ctx, task, `The provider no longer had the working copy (${capability})`))) return null;
    r = await invoke(ctx, task, capability, call, `${key}:restored:${task.work.restores}`);
  }
  return r;
}

/* ------------------------------------------------------------------ opening, preparing, and checks */

async function open(ctx: Ctx, task: Task) {
  const seed = (task.work.seed ?? []) as Array<{ path: string; content: string }>;
  for (const f of seed) if (!task.work.checkpoint?.files?.[f.path]) {
    const hash = await saveBlob(ctx, f.content);
    const cp = task.work.checkpoint ?? { files: {}, seq: 0 };
    task.work = { ...task.work, checkpoint: { ...cp, files: { ...cp.files, [f.path]: hash } } };
  }
  const opened = await invoke(ctx, task, "code.workspace.open", { repository: repo(task), workspace: workspaceName(task), files: seed }, `${task.id}:open`);
  if (opened.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.open", opened);
  const v = opened.value as { sha: string; base: string; tree: string; checks: string[] };
  const cp = task.work.checkpoint ?? { files: {}, seq: 0 };
  await patchWork(ctx, task, { sha: v.sha, base: v.base, checks: v.checks, checkpoint: { ...cp, tree: v.tree, at: now() } });
  await keep(ctx, task, "checkpoint", { seq: cp.seq, base: v.sha, tree: v.tree, files: Object.keys(cp.files).length, seeded: seed.map((f) => f.path) });
  await keep(ctx, task, "observation", { n: 0, action: "open", summary: `Working copy of ${repo(task)} at ${v.base} ${v.sha.slice(0, 12)}${seed.length ? `, with ${seed.map((f) => f.path).join(", ")} from the finding` : ""}; checks: ${v.checks.join(", ")}.` });
  return move(ctx, task, "preparing", "invoke", `Opened a working copy at ${v.sha.slice(0, 12)}; preparing it.`);
}

async function preparing(ctx: Ctx, task: Task) {
  const status = await ws(ctx, task, "code.workspace.status", {}, `${task.id}:status:${task.steps}`);
  if (!status) return { taskId: task.id, status: task.status };
  if (status.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.status", status);
  const v = status.value as { prepared: boolean | null; prepareOutput?: string };
  if (v.prepared === null) return stay(ctx, task, 10_000);
  if (!v.prepared) return halt(ctx, task, "blocked", `The working copy did not prepare; nothing was changed. ${String(v.prepareOutput ?? "").slice(-300)}`);
  return move(ctx, task, task.operation === "assess" ? "investigating" : "implementing", "observe", "Working copy prepared.");
}

type Pending = { run: string; check: string; target: string | null; against: "change" | "base"; purpose: string; n?: number };

/** Start a check and wait for it durably (the run id is recorded; the next step reads the result). */
async function startCheck(ctx: Ctx, task: Task, spec: Omit<Pending, "run">, key: string) {
  const started = await ws(ctx, task, "code.workspace.run", { check: spec.check, ...(spec.target ? { target: spec.target } : {}), against: spec.against }, key);
  if (!started) return { taskId: task.id, status: task.status };
  if (started.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.run", started);
  const run = started.value as { id: string; state: string };
  await patchWork(ctx, task, { pending: { ...spec, run: run.id } });
  return stay(ctx, task, run.state === "running" ? 10_000 : 0);
}

/** The finished run the task waits on, or null after scheduling another look (or after starting it again, if it was lost). */
async function awaitRun(ctx: Ctx, task: Task): Promise<any | null> {
  const pending = task.work.pending as Pending;
  const got = await invoke(ctx, task, "code.workspace.result", { run: pending.run }, `${task.id}:result:${pending.run}:${task.steps}`);
  if (runLost(got)) {
    await keep(ctx, task, "recovery", { why: "check run lost with the provider", run: pending.run, check: pending.check, target: pending.target, against: pending.against });
    await record(ctx, task, "recover", task.status, task.status, `The provider lost run ${pending.run} (${pending.check} ${pending.target ?? ""} against ${pending.against}); running it again.`);
    const { run: _r, ...spec } = pending;
    await startCheck(ctx, task, spec, `${task.id}:rerun:${pending.run}`);
    return null;
  }
  if (got.outcome !== "succeeded") { await unavailable(ctx, task, "code.workspace.result", got); return null; }
  const run = got.value as { state: string; check: string; target: string | null; against: string; tree?: string; exitCode?: number; durationMs?: number; output?: string };
  if (run.state === "running") { await stay(ctx, task, 10_000); return null; }
  await keep(ctx, task, "check_result", { run: pending.run, purpose: pending.purpose, check: run.check, target: run.target, against: run.against, tree: run.tree, exitCode: run.exitCode, durationMs: run.durationMs, verdict: classify(run), output: (run.output ?? "").slice(-4000) });
  await patchWork(ctx, task, { pending: null });
  return run;
}

/** Whether a failing run shows a test failing on its assertions, as opposed to not loading or not running. */
function classify(run: { exitCode?: number; output?: string }): "passed" | "failed_assertion" | "failed_to_run" {
  if (run.exitCode === 0) return "passed";
  const out = run.output ?? "";
  if (/Failed to load|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export named|Transform failed|No test files found|Unknown file extension/i.test(out)) return "failed_to_run";
  return /Tests\s+\d+\s+failed|#\s*fail\s+[1-9]|\b[1-9]\d*\s+failing\b|✖ .*\(/.test(out) ? "failed_assertion" : "failed_to_run";
}

/* ------------------------------------------------------------------ the decision loop */

const ACTIONS: Record<string, { capability: string; description: string; input: string; writes?: true }> = {
  list: { capability: "code.workspace.list", description: "List a directory.", input: `{"path": "packages"}` },
  read: { capability: "code.workspace.read", description: "Read a file, or lines of it (at most 300 at a time).", input: `{"path": "src/a.ts", "startLine": 1, "endLine": 120}` },
  search: { capability: "code.workspace.search", description: "Search for a regular expression (git grep -E), optionally under a path. A dependency's own source is searchable with path node_modules/<package>.", input: `{"pattern": "readAll\\\\(", "path": "packages/x/src"}` },
  run: { capability: "code.workspace.run", description: "Run a declared check: build, or test with a test file path as target. against \"base\" runs the test on the unmodified base commit (with only that test file copied in).", input: `{"check": "test", "target": "packages/x/test/y.test.ts", "against": "change"}` },
  write: { capability: "code.workspace.write", description: "Replace a file's whole content.", input: `{"path": "src/a.ts", "content": "..."}`, writes: true },
  diff: { capability: "code.workspace.diff", description: "Show what you have changed so far.", input: `{}` },
};

async function observations(ctx: Ctx, task: Task): Promise<string> {
  const rows = ((await ctx.db.find(evidence, { taskId: task.id, kind: "observation" })) as Array<{ at: string; data: { n: number; action: string; input?: unknown; summary: string } }>)
    .sort((a, b) => (a.data.n - b.data.n) || (a.at < b.at ? -1 : 1));
  const older = rows.slice(0, Math.max(0, rows.length - OBSERVATIONS_KEPT)).map((r) => `#${r.data.n} ${r.data.action} ${JSON.stringify(r.data.input ?? {})} (result no longer shown)`);
  const recent = rows.slice(-OBSERVATIONS_KEPT).map((r) => `#${r.data.n} ${r.data.action} ${JSON.stringify(r.data.input ?? {})}\n${r.data.summary}`);
  return [...older, ...recent].join("\n\n");
}

function summarize(action: string, value: any): string {
  const text = action === "read" ? `${value.path} lines ${value.startLine}-${value.endLine} of ${value.totalLines}:\n${value.content}`
    : action === "search" ? (value.matches.length ? value.matches.map((m: any) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "no matches")
    : action === "list" ? `${value.path}: ${value.entries.join("  ")}`
    : action === "run" ? `${value.check}${value.target ? ` ${value.target}` : ""} against ${value.against ?? "change"}: ${value.state === "finished" ? `exit ${value.exitCode} in ${Math.round((value.durationMs ?? 0) / 1000)} s\n${value.output}` : "still running"}`
    : action === "write" ? `wrote ${value.path} (${value.bytes} bytes); checkpointed`
    : action === "diff" ? `${value.files.map((f: any) => `${f.path} +${f.additions} -${f.deletions}`).join("\n") || "no changes"}\n${value.patch}`
    : JSON.stringify(value);
  return text.length > OBSERVATION_CHARS ? `${text.slice(0, OBSERVATION_CHARS / 2)}\n…\n${text.slice(-OBSERVATION_CHARS / 2)}` : text;
}

/** One step of the decision loop: { finished } when the model finishes; otherwise one action (or one wait) and the next step queued. */
async function loop(ctx: Ctx, task: Task, spec: { objective: string; guidance: string; allowed: string[]; resultShape: string; limits: Limits; mayWrite: (path: string) => string | null }): Promise<{ finished: unknown } | unknown> {
  const work = task.work;
  if (work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    await keep(ctx, task, "observation", { n: work.pending?.n ?? work.decisions, action: "run", input: { check: run.check, target: run.target, against: run.against }, summary: summarize("run", run) });
    return stay(ctx, task, 0);
  }
  const max = spec.limits.maxDecisions ?? 30, left = max - work.decisions;
  if (left <= 0) return halt(ctx, task, "blocked", `I used my ${work.decisions} decisions without finishing; an operator needs to look at this task before I continue.`);
  const budget = left <= 3
    ? `You have ${left} decision(s) left. Finish now with what you have already substantiated (an empty result is acceptable); do not start a new line of inquiry.`
    : `You have ${left} of ${max} decisions left. Stop pursuing a question you cannot settle with the actions available; record what you can prove instead.`;
  const actions = Object.fromEntries(spec.allowed.map((a) => [a, { description: ACTIONS[a]!.description, input: ACTIONS[a]!.input }]));
  const asked = await invoke(ctx, task, "reasoning.decide", { objective: `${spec.objective}\n\n${budget}`, guidance: spec.guidance, actions, observations: await observations(ctx, task), resultShape: spec.resultShape }, `${task.id}:decide:${work.decisions}`);
  if (asked.outcome !== "succeeded") return unavailable(ctx, task, "reasoning.decide", asked);
  const { decision, usage } = asked.value as { decision: { kind: string; action: string | null; inputJson: string | null; resultJson: string | null; rationale: string }; usage: unknown };
  await keep(ctx, task, "model_usage", usage);
  const n = work.decisions + 1;
  await keep(ctx, task, "decision", { n, ...decision });
  if (decision.kind === "finish") {
    try {
      const finished = JSON.parse(decision.resultJson ?? "null");
      await patchWork(ctx, task, { decisions: n });
      return { finished };
    } catch { await keep(ctx, task, "observation", { n, action: "finish", summary: "Eve refused the result: resultJson was not valid JSON. Finish again with valid JSON." }); }
  } else {
    const action = decision.action ?? "";
    let input: Record<string, unknown> = {};
    let refusal: string | null = null;
    try { input = JSON.parse(decision.inputJson ?? "{}"); } catch { refusal = "inputJson was not valid JSON"; }
    if (!refusal && !spec.allowed.includes(action)) refusal = `${action} is not an action you may take here (${spec.allowed.join(", ")})`;
    const path = typeof input.path === "string" ? input.path.replace(/^\.?\//, "") : "";
    if (!refusal && ACTIONS[action]?.writes) refusal = spec.mayWrite(path) ?? ((spec.limits.forbiddenPaths ?? []).some((p) => path.startsWith(p)) ? `${path} is off limits by policy` : null);
    if (refusal) {
      await keep(ctx, task, "observation", { n, action, input: ACTIONS[action]?.writes ? { path } : input, summary: `Eve refused this action: ${refusal}.` });
    } else {
      const done = await ws(ctx, task, ACTIONS[action]!.capability, action === "write" ? { ...input, path } : input, `${task.id}:act:${n}`);
      if (!done) return { taskId: task.id, status: task.status };
      if (done.outcome === "succeeded" && action === "write") {
        const v = done.value as { sha256: string; tree: string };
        if (v.sha256 !== sha256(String(input.content ?? ""))) return halt(ctx, task, "blocked", `The provider reports writing different content to ${path} than I sent; I stopped.`);
        await checkpoint(ctx, task, path, String(input.content ?? ""), v.tree);
      }
      if (done.outcome === "succeeded" && action === "run" && (done.value as { state: string }).state === "running") {
        const v = done.value as { id: string; check: string; target: string | null; against: "change" | "base" };
        await patchWork(ctx, task, { decisions: n, pending: { run: v.id, check: v.check, target: v.target, against: v.against, purpose: "decision", n } });
        return stay(ctx, task, 10_000);
      }
      const summary = done.outcome === "succeeded" ? summarize(action, done.value) : done.outcome === "unknown" ? `no answer: ${done.reason}` : `${done.outcome}: ${done.error.code} ${done.error.message}`;
      await keep(ctx, task, "observation", { n, action, input: action === "write" ? { path } : input, summary });
    }
  }
  await patchWork(ctx, task, { decisions: n });
  return stay(ctx, task, 0);
}

/* ------------------------------------------------------------------ assess */

const ASSESS_GUIDANCE = [
  "You are assessing reliability: defects that make the software lose or corrupt data, fail under load or concurrency, hang, leak resources, or report success when it failed.",
  "A finding is filed only if Eve can prove it. Prove behavior, not just code: write a focused test (a new file under the package's test directory) that fails today because of the defect,",
  "run it, and cite it as check evidence (kind \"check\", check \"test\", target its path, expect \"fails\"). Add code evidence quoting the exact lines at fault.",
  "The test must fail on its assertions, not because it cannot load. A finding without a failing test is a hypothesis and will not be filed.",
  "You may write only test files here; do not change the code under test. Prefer one real, specific finding over several speculative ones.",
].join(" ");
const ASSESS_SHAPE = `{"findings": [{"title": "short and specific", "severity": "high|medium|low", "summary": "what goes wrong, when, and why", "evidence": [{"kind": "code", "path": "...", "startLine": 10, "endLine": 14, "quote": "exact text from those lines"}, {"kind": "check", "check": "test", "target": "path/to/new.test.ts", "expect": "fails"}], "fix": "the change that would resolve it"}]}`;

async function received(ctx: Ctx, task: Task) {
  const limits = await policyFor(ctx, task);
  if (!limits) return halt(ctx, task, "blocked", `I have no policy that lets me ${task.operation} ${repo(task)}; an operator has to grant it first.`);
  if (task.operation === "resolve") {
    const got = await invoke(ctx, task, "tracker.items.get", { repository: repo(task), number: Number(task.source.message) }, `${task.id}:item:${task.steps}`);
    if (got.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.get", got);
    const issue = got.value as { number: number; title: string; body: string; state: string; url: string; comments: Array<{ author: string; body: string }> };
    await keep(ctx, task, "source_record", issue);
    if (issue.state !== "open") return halt(ctx, task, "blocked", `#${issue.number} is ${issue.state}; I only work on open items.`);
    await patchWork(ctx, task, { item: { number: issue.number, title: issue.title, url: issue.url } });
  }
  return open(ctx, { ...task, status: "opening" });
}

const mayWriteTests = (path: string) => (TEST_FILE.test(path) ? null : `${path} is not a test file; while assessing you may only add tests`);

async function investigating(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const result = await loop(ctx, task, {
    objective: task.work.objective ?? `Find the most important reliability gap in ${repo(task)} that you can prove with a failing test.`,
    guidance: ASSESS_GUIDANCE, allowed: ["list", "read", "search", "run", "write"], resultShape: ASSESS_SHAPE, limits, mayWrite: mayWriteTests,
  });
  if (!(result && typeof result === "object" && "finished" in result)) return result;
  const findings = ((result.finished as { findings?: Finding[] })?.findings ?? []).filter((f) => f && f.title && Array.isArray(f.evidence) && f.evidence.length);
  await patchWork(ctx, task, { findings, prove: { finding: 0, evidence: 0, results: [] } });
  return move(ctx, task, "proving", "decide", `The investigation proposed ${findings.length} finding(s); proving each before anything is filed.`);
}

const squash = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * Prove findings one piece of evidence per step. Code: the cited lines contain the quote. Check: the test is one Eve wrote
 * and checkpointed, and it fails on the unmodified code (this working copy is the base plus tests) on its assertions.
 * A finding with no check evidence is a hypothesis: recorded, never filed.
 */
async function proving(ctx: Ctx, task: Task) {
  const { findings, prove } = task.work as { findings: Finding[]; prove: { finding: number; evidence: number; results: Array<{ finding: number; ok: boolean; why: string }> } };
  if (prove.finding >= findings.length) return move(ctx, task, "filing", "verify", `Proved ${new Set(prove.results.filter((r) => r.ok).map((r) => r.finding)).size} of ${findings.length} finding(s).`);
  const finding = findings[prove.finding]!;
  let verdict: { ok: boolean; why: string } | null = null;
  if (!finding.evidence.some((e) => e.kind === "check")) verdict = { ok: false, why: "a hypothesis: no failing test substantiates it" };
  const ev = finding.evidence[prove.evidence]!;
  if (!verdict && task.work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    const v = classify(run);
    const onBase = run.tree === task.work.checkpoint?.tree;
    verdict = v === "failed_assertion" && onBase ? { ok: true, why: `${run.target} fails on its assertions at tree ${String(run.tree).slice(0, 12)} (base ${String(task.work.sha).slice(0, 12)} plus tests)` }
      : { ok: false, why: `${run.target} ${v === "passed" ? "passes, so it does not show the defect" : v === "failed_to_run" ? "fails without running its assertions (load or setup error)" : "ran on a different tree"}` };
  } else if (!verdict && ev.kind === "code") {
    const read = await ws(ctx, task, "code.workspace.read", { path: ev.path, startLine: Math.max(1, ev.startLine - 2), endLine: ev.endLine + 2 }, `${task.id}:prove:${prove.finding}:${prove.evidence}`);
    if (!read) return { taskId: task.id, status: task.status };
    if (read.outcome !== "succeeded") verdict = { ok: false, why: `${ev.path} could not be read: ${read.outcome}` };
    else {
      const text = ((read.value as { content: string }).content).split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");
      verdict = squash(text).includes(squash(ev.quote)) ? { ok: true, why: `${ev.path}:${ev.startLine}-${ev.endLine} contains the quoted code` } : { ok: false, why: `${ev.path}:${ev.startLine}-${ev.endLine} does not contain the quoted code` };
    }
  } else if (!verdict && ev.kind === "check") {
    if (!task.work.checkpoint?.files?.[ev.target]) verdict = { ok: false, why: `${ev.target} is not a test Eve wrote and checkpointed` };
    else return startCheck(ctx, task, { check: ev.check, target: ev.target, against: "change", purpose: "prove" }, `${task.id}:prove-run:${prove.finding}:${prove.evidence}`);
  } else if (!verdict) verdict = { ok: false, why: "unknown kind of evidence" };
  const results = [...prove.results, { finding: prove.finding, ok: verdict!.ok, why: verdict!.why }];
  const last = !finding.evidence.some((e) => e.kind === "check") || prove.evidence + 1 >= finding.evidence.length || !verdict!.ok;
  if (last) {
    const own = results.filter((r) => r.finding === prove.finding);
    const tests = finding.evidence.filter((e): e is Extract<Evidence, { kind: "check" }> => e.kind === "check").map((e) => ({ path: e.target, sha256: task.work.checkpoint?.files?.[e.target] ?? null }));
    await keep(ctx, task, "finding", { finding, proven: own.length > 0 && own.every((r) => r.ok), verifications: own, tests, tree: task.work.checkpoint?.tree, base: task.work.sha });
  }
  await patchWork(ctx, task, { prove: { finding: last ? prove.finding + 1 : prove.finding, evidence: last ? 0 : prove.evidence + 1, results } });
  await record(ctx, task, "verify", task.status, task.status, `${finding.title}: ${verdict!.ok ? "verified" : "rejected"} (${verdict!.why}).`);
  return stay(ctx, task, 0);
}

async function issueBody(ctx: Ctx, task: Task, finding: Finding, verifications: Array<{ why: string }>, tests: Array<{ path: string; sha256: string | null }>): Promise<string> {
  const sha = task.work.sha;
  const evidenceText = finding.evidence.map((e, i) => e.kind === "code"
    ? `${i + 1}. [\`${e.path}\` lines ${e.startLine}–${e.endLine}](https://github.com/${repo(task)}/blob/${sha}/${e.path}#L${e.startLine}-L${e.endLine}):\n\n\`\`\`\n${e.quote}\n\`\`\``
    : `${i + 1}. \`${e.check} ${e.target}\` fails on its assertions at ${String(sha).slice(0, 12)}.`).join("\n\n");
  const testText: string[] = [];
  for (const t of tests) {
    const [blob] = t.sha256 ? ((await ctx.db.find(blobs, { sha256: t.sha256 })) as Array<{ content: string }>) : [];
    if (blob) testText.push(`<details><summary><code>${t.path}</code> (fails today)</summary>\n\n\`\`\`ts\n${blob.content}\n\`\`\`\n</details>`);
  }
  return [
    finding.summary, "", `**Severity:** ${finding.severity}`, "", "### Evidence", "", evidenceText, "", ...(testText.length ? ["### Reproduction", "", ...testText, ""] : []),
    "### Suggested fix", "", finding.fix, "", "### How this was verified", "", ...verifications.map((v) => `- ${v.why}`), "",
    `Found and verified by Eve2 (task \`${task.id}\`, ${repo(task)}@${String(sha).slice(0, 12)}): the quoted lines were re-read and the reproduction re-run before filing.`,
  ].join("\n");
}

type FindingRecord = { finding: Finding; proven: boolean; verifications: Array<{ ok?: boolean; why: string }>; tests: Array<{ path: string; sha256: string | null }> };

/**
 * File proven findings exactly once, most severe first, within policy: create (or, after an unknown outcome, find the
 * issue by its operation marker), read it back, then start the resolution linked to it. One external step per step.
 */
async function filing(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const all = ((await ctx.db.find(evidence, { taskId: task.id, kind: "finding" })) as Array<{ data: FindingRecord }>).map((r) => r.data);
  const proven = all.filter((d) => d.proven).sort((a, b) => SEVERITY[a.finding.severity] - SEVERITY[b.finding.severity]);
  const filed: Array<{ title: string; operation?: string; number?: number; url?: string; verified?: boolean; resolution?: string; skipped?: string }> = task.work.filed ?? [];
  const open = filed.find((f) => !f.skipped && (!f.verified || (limits.autoResolve && !f.resolution)));
  const created = filed.filter((f) => f.number).length;
  const nextFinding = proven.find((p) => !filed.some((f) => f.title === p.finding.title));
  if (!open && (!nextFinding || created >= (limits.maxIssues ?? 1))) {
    const report = { filed: filed.filter((f) => f.number), skipped: filed.filter((f) => f.skipped), notFiled: proven.filter((p) => !filed.some((f) => f.title === p.finding.title)).map((p) => p.finding.title), hypotheses: all.filter((d) => !d.proven).map((d) => ({ title: d.finding.title, why: d.verifications.find((v) => v.ok === false)?.why })), decisions: task.work.decisions };
    await ctx.db.patch(tasks, task.id, { report });
    return move(ctx, task, "completed", "report", `Filed ${report.filed.length} issue(s); ${report.skipped.length} already tracked, ${report.notFiled.length} over the limit, ${report.hypotheses.length} not proven.`);
  }
  const replace = async (entry: (typeof filed)[number]) => patchWork(ctx, task, { filed: [...filed.filter((f) => f.title !== entry.title), entry] });
  if (!open) {
    const f = nextFinding!.finding;
    const dup = await invoke(ctx, task, "tracker.items.find", { repository: repo(task), query: f.title }, `${task.id}:dup:${digest(f.title)}`);
    if (dup.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.find", dup);
    const matches = (dup.value as { matches: Array<{ number: number }> }).matches;
    await replace(matches.length ? { title: f.title, skipped: `possibly already tracked as #${matches[0]!.number}` } : { title: f.title, operation: `${task.id}:issue:${digest(f.title)}` });
    return stay(ctx, task, 0);
  }
  const record_ = proven.find((p) => p.finding.title === open.title)!;
  if (!open.number) {
    const made = await invoke(ctx, task, "tracker.items.create", { repository: repo(task), operation: open.operation, title: open.title, body: await issueBody(ctx, task, record_.finding, record_.verifications, record_.tests) }, `${task.id}:file:${open.operation}`);
    if (made.outcome === "succeeded") {
      const issue = made.value as { number: number; url: string; reconciled: boolean };
      if (issue.reconciled) await record(ctx, task, "recover", task.status, task.status, `The tracker already had #${issue.number} for this operation; not filed again.`);
      await replace({ ...open, number: issue.number, url: issue.url });
      return stay(ctx, task, 0);
    }
    if (made.outcome !== "unknown") return unavailable(ctx, task, "tracker.items.create", made);
    // Unknown: the issue may exist. Look for it by its operation marker before anything is sent again.
    const found = await invoke(ctx, task, "tracker.items.find", { repository: repo(task), operation: open.operation }, `${task.id}:reconcile-issue:${task.steps}`);
    if (found.outcome === "succeeded" && (found.value as { matches: unknown[] }).matches.length) {
      const issue = (found.value as { matches: Array<{ number: number; url: string }> }).matches[0]!;
      await keep(ctx, task, "recovery", { why: "issue creation had an unknown outcome", reconciled: "found by operation marker", number: issue.number });
      await record(ctx, task, "recover", task.status, task.status, `Issue creation had an unknown outcome; found #${issue.number} by its operation marker. Not filed again.`);
      await replace({ ...open, number: issue.number, url: issue.url });
      return stay(ctx, task, 0);
    }
    await record(ctx, task, "recover", task.status, task.status, "Issue creation had an unknown outcome and no issue carries its operation marker; it will be sent again with the same key.");
    return unavailable(ctx, task, "tracker.items.create", made);
  }
  if (!open.verified) {
    const got = await invoke(ctx, task, "tracker.items.get", { repository: repo(task), number: open.number }, `${task.id}:verify-issue:${open.number}:${task.steps}`);
    if (got.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.get", got);
    const issue = got.value as { number: number; title: string; body: string; state: string; url: string };
    const ok = issue.title === open.title && issue.body.includes(`eve2:operation=${open.operation}`) && issue.state === "open";
    await keep(ctx, task, "artifact", { kind: "issue", number: issue.number, url: issue.url, title: issue.title, operation: open.operation, verified: ok });
    if (!ok) return halt(ctx, task, "verification_failed", `#${issue.number} does not read back as the issue I filed (title, marker or state differ).`);
    await replace({ ...open, verified: true, url: issue.url });
    return stay(ctx, task, 0);
  }
  // Start the resolution, linked to the finding and its reproduction (one task per issue: a repeat finds the same task).
  const seed = await Promise.all(record_.tests.filter((t) => t.sha256).map(async (t) => ({ path: t.path, content: ((await ctx.db.find(blobs, { sha256: t.sha256 })) as Array<{ content: string }>)[0]!.content })));
  const started = await createTask(ctx, "resolve", { system: "tracker", conversation: repo(task), message: String(open.number) }, { objective: null, origin: { assessTask: task.id, operation: open.operation, finding: open.title }, seed });
  await keep(ctx, task, "artifact", { kind: "resolution", taskId: started.taskId, issue: open.number, duplicate: Boolean((started as { duplicate?: boolean }).duplicate) });
  await replace({ ...open, resolution: started.taskId });
  return stay(ctx, task, 0);
}

/* ------------------------------------------------------------------ resolve */

const RESOLVE_GUIDANCE = [
  "You are resolving one work item with a minimal, correct change. Read the item and the code it concerns. If a reproduction test is already in the working copy, run it first: it fails today.",
  "Make the smallest change that fixes the defect, and keep or add a test that fails before your change and passes after it (you can check with against \"base\"). Run the tests you touched.",
  "Do not change unrelated code, dependencies, lockfiles or CI configuration. Finish only when the tests you name pass on your change.",
].join(" ");
const RESOLVE_SHAPE = `{"summary": "what was wrong and what you changed", "tests": ["path/to/test/file.test.ts"]}`;

async function implementing(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const issue = (await latestSource(ctx, task)) as { number: number; title: string; body: string; comments: Array<{ author: string; body: string }> };
  const seeded = ((task.work.seed ?? []) as Array<{ path: string }>).map((f) => f.path);
  const result = await loop(ctx, task, {
    objective: `Resolve ${repo(task)}#${issue.number}: ${issue.title}\n\n${issue.body}${issue.comments.length ? `\n\nComments:\n${issue.comments.map((c) => `${c.author}: ${c.body}`).join("\n")}` : ""}${seeded.length ? `\n\nAlready in the working copy from the finding: ${seeded.join(", ")} (fails today).` : ""}`,
    guidance: RESOLVE_GUIDANCE, allowed: ["list", "read", "search", "run", "write", "diff"], resultShape: RESOLVE_SHAPE, limits, mayWrite: () => null,
  });
  if (!(result && typeof result === "object" && "finished" in result)) return result;
  const finished = result.finished as { summary?: string; tests?: string[] };
  const tests = [...new Set([...(finished.tests ?? []).filter((t) => typeof t === "string"), ...seeded])];
  await patchWork(ctx, task, { summary: finished.summary ?? "", tests, gate: { stage: "diff", index: 0, change: [], base: [] } });
  return move(ctx, task, "checking", "decide", `The implementation is ready for Eve's checks: ${tests.length} test file(s).`);
}

async function latestSource(ctx: Ctx, task: Task) {
  const rows = (await ctx.db.find(evidence, { taskId: task.id, kind: "source_record" })) as Array<{ at: string; data: unknown }>;
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.data;
}

/**
 * Eve's gate before anything is proposed, on the exact checkpointed revision:
 *   diff    bounded, within policy, includes a test, and at the checkpointed tree
 *   change  every named test passes, on that tree
 *   base    every test file the change adds or modifies fails on the unmodified base, on its assertions
 */
async function checking(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const tests = task.work.tests as string[];
  const gate = task.work.gate as { stage: "diff" | "change" | "base"; index: number; change: Array<{ target: string; exitCode: number; tree: string }>; base: Array<{ target: string; exitCode: number; verdict: string }>; baseTargets?: string[] };
  const back = async (why: string) => {
    const attempts = (task.work.gateAttempts ?? 0) + 1;
    if (attempts > (limits.maxGateAttempts ?? 2)) return halt(ctx, task, "blocked", `My change did not pass my own checks after ${attempts - 1} attempt(s) (${why}). Nothing was proposed.`);
    await keep(ctx, task, "observation", { n: task.work.decisions, action: "gate", summary: `Eve's own check refused the result: ${why}. Fix this, run the tests, and finish again.` });
    await patchWork(ctx, task, { gateAttempts: attempts, gate: null, pending: null });
    return move(ctx, task, "implementing", "verify", `Eve's own check refused the result (${why}); back to implementation.`);
  };
  const tree = task.work.checkpoint?.tree as string;
  if (gate.stage === "diff") {
    const diff = await ws(ctx, task, "code.workspace.diff", {}, `${task.id}:gate-diff:${task.steps}`);
    if (!diff) return { taskId: task.id, status: task.status };
    if (diff.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.diff", diff);
    const d = diff.value as { files: Array<{ path: string; additions: number; deletions: number }>; patchSha256: string; tree: string };
    if (d.tree !== tree) return back(`the working copy is at tree ${d.tree.slice(0, 12)}, not the checkpointed ${String(tree).slice(0, 12)}`);
    if (!d.files.length) return back("the working copy has no changes");
    if (d.files.length > (limits.maxFiles ?? 5)) return back(`${d.files.length} files changed, more than the ${limits.maxFiles ?? 5} allowed`);
    const forbidden = d.files.filter((f) => (limits.forbiddenPaths ?? []).some((p) => f.path.startsWith(p)));
    if (forbidden.length) return back(`${forbidden.map((f) => f.path).join(", ")} may not be changed`);
    const changedTests = d.files.map((f) => f.path).filter((p) => TEST_FILE.test(p));
    if (!changedTests.length) return back("no test file was added or changed");
    if (!d.files.some((f) => !TEST_FILE.test(f.path))) return back("only tests changed; nothing fixes the defect");
    if (!tests.length) return back("no test was named");
    await keep(ctx, task, "verification", { stage: "diff", tree: d.tree, files: d.files, patchSha256: d.patchSha256 });
    await patchWork(ctx, task, { diff: d, gate: { ...gate, stage: "change", index: 0, baseTargets: [...new Set([...changedTests, ...tests.filter((t) => changedTests.includes(t))])] } });
    return stay(ctx, task, 0);
  }
  if (task.work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    if (gate.stage === "change") {
      if (run.tree !== tree) return back(`${run.target} ran on tree ${String(run.tree).slice(0, 12)}, not the checkpointed ${String(tree).slice(0, 12)}`);
      if (run.exitCode !== 0) return back(`${run.target} fails on the change (exit ${run.exitCode})`);
      await patchWork(ctx, task, { gate: { ...gate, index: gate.index + 1, change: [...gate.change, { target: run.target, exitCode: run.exitCode, tree: run.tree }] } });
    } else {
      const verdict = classify(run);
      await patchWork(ctx, task, { gate: { ...gate, index: gate.index + 1, base: [...gate.base, { target: run.target, exitCode: run.exitCode, verdict }] } });
    }
    return stay(ctx, task, 0);
  }
  if (gate.stage === "change" && gate.index < tests.length) return startCheck(ctx, task, { check: "test", target: tests[gate.index]!, against: "change", purpose: "gate-change" }, `${task.id}:gate-change:${task.work.gateAttempts ?? 0}:${gate.index}`);
  if (gate.stage === "change") { await patchWork(ctx, task, { gate: { ...gate, stage: "base", index: 0 } }); return stay(ctx, task, 0); }
  const targets = gate.baseTargets ?? [];
  if (gate.index < targets.length) return startCheck(ctx, task, { check: "test", target: targets[gate.index]!, against: "base", purpose: "gate-base" }, `${task.id}:gate-base:${task.work.gateAttempts ?? 0}:${gate.index}`);
  const demonstrating = gate.base.filter((b) => b.verdict === "failed_assertion");
  if (!demonstrating.length) return back(`none of ${targets.join(", ")} fails on the unmodified base on its assertions (${gate.base.map((b) => `${b.target}: ${b.verdict}`).join("; ")}), so no test demonstrates the defect`);
  await keep(ctx, task, "verification", { stage: "tests", tree, change: gate.change, base: gate.base });
  await patchWork(ctx, task, { verifiedTree: tree });
  return move(ctx, task, "publishing", "verify", `On tree ${String(tree).slice(0, 12)}: ${gate.change.length} test file(s) pass; ${demonstrating.length} fail on the unmodified base. Proposing the change.`);
}

const branchOf = (task: Task) => `eve/issue-${task.work.item.number}-${task.id.slice(-8).toLowerCase()}`;
const publishOperation = (task: Task) => `${task.id}:publish`;

async function publishing(ctx: Ctx, task: Task) {
  const item = task.work.item as { number: number; title: string; url: string };
  const g = task.work.gate;
  const body = [
    `Refs #${item.number}.`, "", task.work.summary, "", "### Changes", "", ...task.work.diff.files.map((f: any) => `- \`${f.path}\` (+${f.additions} −${f.deletions})`), "",
    "### What Eve verified before proposing this", "", `On content tree \`${String(task.work.verifiedTree).slice(0, 12)}\` (base ${String(task.work.sha).slice(0, 12)}):`,
    ...g.change.map((r: any) => `- \`${r.target}\` passes with the change`), ...g.base.map((r: any) => `- \`${r.target}\` on the unmodified base: ${r.verdict === "failed_assertion" ? "fails on its assertions" : r.verdict}`), "",
    "### Not verified", "", "- CI on this branch (reported after it runs).", "- Behavior beyond the tests named above.", "",
    `Proposed by Eve2 (task \`${task.id}\`). Not merged: a person decides.`,
  ].join("\n");
  const published = await ws(ctx, task, "code.changes.publish", {
    operation: publishOperation(task), branch: branchOf(task), expectTree: task.work.verifiedTree,
    title: `Resolve #${item.number}: ${item.title}`.slice(0, 120), body, message: `Resolve #${item.number}: ${item.title}\n\n${task.work.summary}`,
  }, `${task.id}:publish`);
  if (!published) return { taskId: task.id, status: task.status };
  if (published.outcome === "succeeded") {
    const pr = published.value as { number: number; url: string; headSha: string; steps: string[]; reconciled: boolean };
    if (pr.reconciled) await record(ctx, task, "recover", task.status, task.status, `Pull request #${pr.number} already existed for this operation; not opened again.`);
    await ctx.db.patch(tasks, task.id, { target: { id: String(pr.number), kind: "change" } });
    await keep(ctx, task, "artifact", { kind: "pull_request", number: pr.number, url: pr.url, headSha: pr.headSha, steps: pr.steps, reconciled: pr.reconciled });
    return move(ctx, task, "verifying", "invoke", `Pull request #${pr.number}: ${pr.steps.join("; ")}. Reading it back.`);
  }
  if (published.outcome === "unknown" || published.outcome === "failed") {
    // Before sending again, ask GitHub what exists for this operation.
    const found = await invoke(ctx, task, "code.changes.find", { repository: repo(task), operation: publishOperation(task), branch: branchOf(task) }, `${task.id}:reconcile-publish:${task.steps}`);
    if (found.outcome === "succeeded") {
      const v = found.value as { branch: { sha: string } | null; pullRequest: { number: number; url: string; headSha: string } | null };
      await keep(ctx, task, "recovery", { why: `publishing ${published.outcome}`, branch: v.branch, pullRequest: v.pullRequest?.number ?? null });
      if (v.pullRequest) {
        await record(ctx, task, "recover", task.status, task.status, `Publishing was ${published.outcome}; #${v.pullRequest.number} exists for this operation. Not opened again.`);
        await ctx.db.patch(tasks, task.id, { target: { id: String(v.pullRequest.number), kind: "change" } });
        await keep(ctx, task, "artifact", { kind: "pull_request", number: v.pullRequest.number, url: v.pullRequest.url, headSha: v.pullRequest.headSha, steps: ["found after an uncertain outcome"], reconciled: true });
        return move(ctx, task, "verifying", "decide", `Reconciled: #${v.pullRequest.number} exists; reading it back.`);
      }
      await record(ctx, task, "recover", task.status, task.status, `Publishing was ${published.outcome}; ${v.branch ? `${branchOf(task)} exists at ${v.branch.sha.slice(0, 12)} with no pull request` : "no branch and no pull request exist"}. Publishing again reconciles the branch by content.`);
    }
  }
  return unavailable(ctx, task, "code.changes.publish", published);
}

async function verifying(ctx: Ctx, task: Task) {
  const got = await invoke(ctx, task, "code.changes.get", { repository: repo(task), number: Number(task.target!.id) }, `${task.id}:verify:${task.steps}`);
  if (got.outcome !== "succeeded") return unavailable(ctx, task, "code.changes.get", got);
  const pr = got.value as { number: number; url: string; state: string; merged: boolean; headSha: string; branch: string; body: string; files: Array<{ path: string }>; checks: Array<{ name: string; status: string; conclusion: string | null }> };
  await keep(ctx, task, "target_record", pr);
  const expected = (task.work.diff.files as Array<{ path: string }>).map((f) => f.path).sort();
  const checks = { open: pr.state === "open", notMerged: !pr.merged, branch: pr.branch === branchOf(task), operation: pr.body.includes(`eve2:operation=${publishOperation(task)}`), files: JSON.stringify(pr.files.map((f) => f.path).sort()) === JSON.stringify(expected) };
  await keep(ctx, task, "verification", { stage: "pull_request", checks, ci: pr.checks, headSha: pr.headSha });
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) return halt(ctx, task, "verification_failed", `Pull request #${pr.number} does not match what I prepared (${failed.join(", ")}). I am not reporting it as ready.`);
  await patchWork(ctx, task, { pr: { number: pr.number, url: pr.url, headSha: pr.headSha, ci: pr.checks } });
  return move(ctx, task, "reporting", "verify", `Verified #${pr.number}: open, not merged, on ${pr.branch}, carrying this operation, and changing exactly the files Eve checked.`);
}

async function reporting(ctx: Ctx, task: Task) {
  const pr = task.work.pr;
  const g = task.work.gate;
  const ci = pr.ci.length ? pr.ci.map((c: any) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") : "no CI runs reported yet";
  const text = `I proposed a fix in ${pr.url} (not merged).\n\n${task.work.summary}\n\nBefore opening it I ran, on the exact content of the branch: ${g.change.map((r: any) => `\`${r.target}\` passes`).join(", ")}; on the unmodified base, ${g.base.filter((r: any) => r.verdict === "failed_assertion").map((r: any) => `\`${r.target}\` fails`).join(", ")}. CI on ${String(pr.headSha).slice(0, 12)} when I checked: ${ci}.`;
  const said = await notify(ctx, task, text, "report");
  if (said && said.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.comment", said);
  await ctx.db.patch(tasks, task.id, { report: { pullRequest: pr, tests: { change: g.change, base: g.base }, tree: task.work.verifiedTree, summary: task.work.summary, origin: task.work.origin ?? null } });
  return move(ctx, task, "completed", "report", `Reported #${pr.number} on the item.`);
}

export const ASSESS_STEPS: Record<string, (ctx: Ctx, task: Task) => Promise<unknown>> = { received, opening: open, preparing, investigating, proving, filing };
export const RESOLVE_STEPS: Record<string, (ctx: Ctx, task: Task) => Promise<unknown>> = { received, opening: open, preparing, implementing, checking, publishing, verifying, reporting };

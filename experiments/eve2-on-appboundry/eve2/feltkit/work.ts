/**
 * Work on code and work items, through neutral contracts (tracker.items.*, code.workspace.*, code.changes.*).
 *
 *   assess   investigate a repository, prove each finding deterministically (the cited lines say what the finding
 *            quotes; a cited check really fails), and file only proven, new findings, within policy
 *   resolve  take a work item to a proposed change: implement in a working copy, pass Eve's own gate (a bounded diff,
 *            and the checks re-run by Eve, passing), publish for review (never merge), read it back, report on the item
 *
 * The model chooses the next action from a fixed list (reasoning.decide); Eve validates it against the policy and
 * performs it through a capability; the result becomes an observation. Every decision, action and observation is a
 * durable record; a check that runs long is waited for durably, one step at a time.
 */
import { s } from "@feltdb/feltkit";
import { app, evidence, policies, tasks } from "./app.js";
import { digest, halt, invoke, keep, move, notify, now, record, unavailable, wait, type Ctx, type Task } from "./_ops.js";

type Limits = { repositories?: string[]; maxDecisions?: number; maxIssues?: number; maxFiles?: number; forbiddenPaths?: string[]; maxGateAttempts?: number };
type Evidence = { kind: "code"; path: string; startLine: number; endLine: number; quote: string } | { kind: "check"; check: string; target: string; expect: "fails" };
type Finding = { title: string; severity: "high" | "medium" | "low"; summary: string; evidence: Evidence[]; fix: string };
const SEVERITY = { high: 0, medium: 1, low: 2 } as const;
const OBSERVATION_CHARS = 3500;
const OBSERVATIONS_KEPT = 40;

/* ------------------------------------------------------------------ assign: an operator gives Eve work */

export const assign = app.mutation({
  access: "tasks.assign",
  args: { operation: s.enum(["assess", "resolve"] as const), repository: s.string(), item: s.optional(s.number()), objective: s.optional(s.string()), assignment: s.string() },
  handler: async (ctx: Ctx, a: { operation: "assess" | "resolve"; repository: string; item?: number; objective?: string; assignment: string }) => {
    if (a.operation === "resolve" && !a.item) throw new Error("resolve needs the work item's number.");
    const source = a.operation === "resolve" ? { system: "tracker", conversation: a.repository, message: String(a.item) } : { system: "operator", conversation: a.repository, message: a.assignment };
    const sourceKey = `${source.system}:${source.conversation}:${source.message}`;
    const [existing] = (await ctx.db.find(tasks, { sourceKey })) as Task[];
    if (existing) return { taskId: existing.id, status: existing.status, duplicate: true };
    const at = now();
    const id = await ctx.db.insert(tasks, {
      sourceKey, source, operation: a.operation, status: "received", reference: `EVE-${digest(sourceKey).slice(0, 12).toUpperCase()}`, attempts: 0, steps: 0,
      work: { objective: a.objective ?? null, decisions: 0, gateAttempts: 0 }, createdAt: at, updatedAt: at,
    });
    ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: id }, { maxAttempts: 3 });
    return { taskId: id, status: "received" };
  },
});

/* ------------------------------------------------------------------ shared: policy, workspace, the decision loop */

async function policyFor(ctx: Ctx, task: Task): Promise<Limits | null> {
  const [policy] = (await ctx.db.find(policies, { operation: `${task.operation}.repository` })) as Array<{ limits?: Limits }>;
  if (!policy) return null;
  const limits = policy.limits ?? {};
  return limits.repositories?.includes(task.source.conversation) ? limits : null;
}

/** Successive patches in one step build on each other: the task's working state is updated in place, then written. */
const patchWork = (ctx: Ctx, task: Task, work: Record<string, unknown>) => {
  task.work = { ...task.work, ...work };
  return ctx.db.patch(tasks, task.id, { work: task.work, updatedAt: now() });
};
const later = (ctx: Ctx, task: Task, ms: number) => ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3, runAt: new Date(Date.now() + ms).toISOString() });

async function open(ctx: Ctx, task: Task) {
  const opened = await invoke(ctx, task, "code.workspace.open", { repository: task.source.conversation }, `${task.id}:open`);
  if (opened.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.open", opened);
  const v = opened.value as { workspace: string; sha: string; base: string; checks: string[]; prepare: { id: string } };
  await keep(ctx, task, "observation", { n: 0, action: "open", summary: `Working copy of ${task.source.conversation} at ${v.base} ${v.sha.slice(0, 12)}; checks: ${v.checks.join(", ")}.` });
  await patchWork(ctx, task, { workspace: v.workspace, sha: v.sha, base: v.base, checks: v.checks, pending: { run: v.prepare.id, purpose: "prepare" } });
  return move(ctx, task, "preparing", "invoke", `Opened a working copy at ${v.sha.slice(0, 12)}; preparing it (install and build).`);
}

/** Wait, durably, for the check a task is waiting on. Returns the finished run, or null after scheduling another look. */
async function awaitRun(ctx: Ctx, task: Task): Promise<any | null> {
  const pending = task.work.pending;
  const got = await invoke(ctx, task, "code.workspace.result", { run: pending.run }, `${task.id}:result:${pending.run}:${task.steps}`);
  if (got.outcome !== "succeeded") { await unavailable(ctx, task, "code.workspace.result", got); return null; }
  const run = got.value as { state: string; check: string; target: string | null; exitCode?: number; durationMs?: number; output?: string };
  if (run.state === "running") {
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1, updatedAt: now() });
    later(ctx, task, 10_000);
    return null;
  }
  await keep(ctx, task, "check_result", { run: pending.run, purpose: pending.purpose, check: run.check, target: run.target, exitCode: run.exitCode, durationMs: run.durationMs, output: (run.output ?? "").slice(-4000) });
  return run;
}

async function preparing(ctx: Ctx, task: Task) {
  const run = await awaitRun(ctx, task);
  if (!run) return { taskId: task.id, status: task.status };
  await patchWork(ctx, task, { pending: null });
  if (run.exitCode !== 0) return halt(ctx, task, "blocked", `The working copy did not prepare (${run.check} exited ${run.exitCode}); nothing was changed.`);
  return move(ctx, task, task.operation === "assess" ? "investigating" : "implementing", "observe", `Working copy prepared in ${Math.round((run.durationMs ?? 0) / 1000)} s.`);
}

const ACTIONS: Record<string, { capability: string; description: string; input: string; writes?: true }> = {
  list: { capability: "code.workspace.list", description: "List a directory.", input: `{"path": "packages"}` },
  read: { capability: "code.workspace.read", description: "Read a file, or lines of it (at most 300 at a time).", input: `{"path": "src/a.ts", "startLine": 1, "endLine": 120}` },
  search: { capability: "code.workspace.search", description: "Search for a regular expression (git grep -E), optionally under a path. A dependency's own source is searchable with path node_modules/<package>.", input: `{"pattern": "readAll\\\\(", "path": "packages/appboundry-host/src"}` },
  run: { capability: "code.workspace.run", description: "Run a declared check: build, or test with a test file path as target.", input: `{"check": "test", "target": "packages/x/test/y.test.ts"}` },
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
    : action === "run" ? `${value.check}${value.target ? ` ${value.target}` : ""}: ${value.state === "finished" ? `exit ${value.exitCode} in ${Math.round(value.durationMs / 1000)} s\n${value.output}` : "still running"}`
    : action === "write" ? `wrote ${value.path} (${value.bytes} bytes)`
    : action === "diff" ? `${value.files.map((f: any) => `${f.path} +${f.additions} -${f.deletions}`).join("\n") || "no changes"}\n${value.patch}`
    : JSON.stringify(value);
  return text.length > OBSERVATION_CHARS ? `${text.slice(0, OBSERVATION_CHARS / 2)}\n…\n${text.slice(-OBSERVATION_CHARS / 2)}` : text;
}

/**
 * One step of the decision loop. Returns { finished: result } when the model finishes; otherwise performs one action
 * (or waits for one) and schedules the next step.
 */
async function loop(ctx: Ctx, task: Task, spec: { objective: string; guidance: string; allowed: string[]; resultShape: string; limits: Limits }): Promise<{ finished: unknown } | unknown> {
  const work = task.work;
  if (work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    await keep(ctx, task, "observation", { n: work.pending.n, action: "run", input: { check: run.check, target: run.target }, summary: summarize("run", run) });
    await patchWork(ctx, task, { pending: null });
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
    later(ctx, task, 0);
    return { taskId: task.id, status: task.status };
  }
  if (work.decisions >= (spec.limits.maxDecisions ?? 30)) return halt(ctx, task, "blocked", `I used my ${work.decisions} decisions without finishing; an operator needs to look at this task before I continue.`);
  const actions = Object.fromEntries(spec.allowed.map((a) => [a, { description: ACTIONS[a]!.description, input: ACTIONS[a]!.input }]));
  const max = spec.limits.maxDecisions ?? 30, left = max - work.decisions;
  const budget = left <= 3
    ? `You have ${left} decision(s) left. Finish now with what you have already substantiated (an empty result is acceptable); do not start a new line of inquiry.`
    : `You have ${left} of ${max} decisions left. Stop pursuing a question you cannot settle with the actions available; record what you can prove instead.`;
  const asked = await invoke(ctx, task, "reasoning.decide", { objective: `${spec.objective}\n\n${budget}`, guidance: spec.guidance, actions, observations: await observations(ctx, task), resultShape: spec.resultShape }, `${task.id}:decide:${work.decisions}`);
  if (asked.outcome !== "succeeded") return unavailable(ctx, task, "reasoning.decide", asked);
  const { decision, usage } = asked.value as { decision: { kind: string; action: string | null; inputJson: string | null; resultJson: string | null; rationale: string }; usage: unknown };
  await keep(ctx, task, "model_usage", usage);
  await keep(ctx, task, "decision", { n: work.decisions + 1, ...decision });
  const n = work.decisions + 1;
  if (decision.kind === "finish") {
    try { return { finished: JSON.parse(decision.resultJson ?? "null") }; }
    catch { await keep(ctx, task, "observation", { n, action: "finish", summary: "Eve refused the result: resultJson was not valid JSON. Finish again with valid JSON." }); }
  } else {
    const action = decision.action ?? "";
    let input: Record<string, unknown> = {};
    let refusal: string | null = null;
    try { input = JSON.parse(decision.inputJson ?? "{}"); } catch { refusal = "inputJson was not valid JSON"; }
    if (!refusal && !spec.allowed.includes(action)) refusal = `${action} is not an action you may take here (${spec.allowed.join(", ")})`;
    const path = typeof input.path === "string" ? input.path.replace(/^\.?\//, "") : "";
    if (!refusal && ACTIONS[action]?.writes && (spec.limits.forbiddenPaths ?? []).some((p) => path.startsWith(p))) refusal = `${path} is off limits by policy`;
    if (refusal) {
      await keep(ctx, task, "observation", { n, action, input, summary: `Eve refused this action: ${refusal}.` });
    } else {
      const done = await invoke(ctx, task, ACTIONS[action]!.capability, { ...input, workspace: work.workspace }, `${task.id}:act:${n}`);
      if (done.outcome === "succeeded" && action === "run" && (done.value as { state: string }).state === "running") {
        await patchWork(ctx, task, { decisions: n, pending: { run: (done.value as { id: string }).id, purpose: "decision", n } });
        await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
        later(ctx, task, 10_000);
        return { taskId: task.id, status: task.status };
      }
      const summary = done.outcome === "succeeded" ? summarize(action, done.value) : done.outcome === "unknown" ? `no answer: ${done.reason}` : `${done.outcome}: ${done.error.code} ${done.error.message}`;
      await keep(ctx, task, "observation", { n, action, input: action === "write" ? { path } : input, summary });
    }
  }
  await patchWork(ctx, task, { decisions: n });
  await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
  later(ctx, task, 0);
  return { taskId: task.id, status: task.status };
}

/* ------------------------------------------------------------------ assess */

const ASSESS_GUIDANCE = [
  "You are assessing reliability: defects that make the software lose or corrupt data, fail under load or concurrency, hang, leak resources, or report success when it failed.",
  "Report only what you can substantiate from the code or a failing check. Every finding needs evidence Eve will verify itself before filing anything:",
  "code evidence quotes the exact text of the cited lines (copy it from what you read), and check evidence names a test file that fails today.",
  "Prefer a few real, specific findings over many speculative ones. Style, naming and missing documentation are out of scope.",
].join(" ");
const ASSESS_SHAPE = `{"findings": [{"title": "short and specific", "severity": "high|medium|low", "summary": "what goes wrong, when, and why", "evidence": [{"kind": "code", "path": "...", "startLine": 10, "endLine": 14, "quote": "exact text from those lines"}, {"kind": "check", "check": "test", "target": "path/to/a.test.ts", "expect": "fails"}], "fix": "the change that would resolve it"}]}`;

async function received(ctx: Ctx, task: Task) {
  const limits = await policyFor(ctx, task);
  if (!limits) return halt(ctx, task, "blocked", `I have no policy that lets me ${task.operation} ${task.source.conversation}; an operator has to grant it first.`);
  if (task.operation === "resolve") {
    const got = await invoke(ctx, task, "tracker.items.get", { repository: task.source.conversation, number: Number(task.source.message) }, `${task.id}:item:${task.steps}`);
    if (got.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.get", got);
    const issue = got.value as { number: number; title: string; body: string; state: string; url: string; comments: Array<{ author: string; body: string }> };
    await keep(ctx, task, "source_record", issue);
    if (issue.state !== "open") return halt(ctx, task, "blocked", `#${issue.number} is ${issue.state}; I only work on open items.`);
    await patchWork(ctx, task, { item: { number: issue.number, title: issue.title, url: issue.url } });
  }
  return open(ctx, { ...task, status: "opening" });
}

async function investigating(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const result = await loop(ctx, task, {
    objective: task.work.objective ?? `Find the most important reliability gaps in ${task.source.conversation} that you can substantiate.`,
    guidance: ASSESS_GUIDANCE, allowed: ["list", "read", "search", "run"], resultShape: ASSESS_SHAPE, limits,
  });
  if (!(result && typeof result === "object" && "finished" in result)) return result;
  const findings = ((result.finished as { findings?: Finding[] })?.findings ?? []).filter((f) => f && f.title && Array.isArray(f.evidence) && f.evidence.length);
  await patchWork(ctx, task, { findings, prove: { finding: 0, evidence: 0, results: [] } });
  return move(ctx, task, "proving", "decide", `The investigation proposed ${findings.length} finding(s); proving each before anything is filed.`);
}

const squash = (t: string) => t.replace(/\s+/g, " ").trim();

/** Prove findings one piece of evidence per step: re-read the quoted lines, or re-run the cited check. */
async function proving(ctx: Ctx, task: Task) {
  const { findings, prove } = task.work as { findings: Finding[]; prove: { finding: number; evidence: number; results: Array<{ finding: number; ok: boolean; why: string }> } };
  if (prove.finding >= findings.length) return move(ctx, task, "filing", "verify", `Proved ${new Set(prove.results.filter((r) => r.ok).map((r) => r.finding)).size} of ${findings.length} finding(s).`);
  const finding = findings[prove.finding]!;
  const ev = finding.evidence[prove.evidence]!;
  let verdict: { ok: boolean; why: string } | null = null;
  if (task.work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    await patchWork(ctx, task, { pending: null });
    task = { ...task, work: { ...task.work, pending: null } };
    verdict = run.exitCode !== 0 ? { ok: true, why: `${run.check} ${run.target} exits ${run.exitCode}` } : { ok: false, why: `${run.check} ${run.target} passes, so it does not show the defect` };
  } else if (ev.kind === "code") {
    const read = await invoke(ctx, task, "code.workspace.read", { workspace: task.work.workspace, path: ev.path, startLine: Math.max(1, ev.startLine - 2), endLine: ev.endLine + 2 }, `${task.id}:prove:${prove.finding}:${prove.evidence}`);
    if (read.outcome !== "succeeded") verdict = { ok: false, why: `${ev.path} could not be read: ${read.outcome}` };
    else {
      const text = ((read.value as { content: string }).content).split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");
      verdict = squash(text).includes(squash(ev.quote)) ? { ok: true, why: `${ev.path}:${ev.startLine}-${ev.endLine} contains the quoted code` } : { ok: false, why: `${ev.path}:${ev.startLine}-${ev.endLine} does not contain the quoted code` };
    }
  } else if (ev.kind === "check") {
    const started = await invoke(ctx, task, "code.workspace.run", { workspace: task.work.workspace, check: ev.check, target: ev.target }, `${task.id}:prove-run:${prove.finding}:${prove.evidence}`);
    if (started.outcome !== "succeeded") verdict = { ok: false, why: `${ev.check} ${ev.target} could not be run: ${started.outcome === "unknown" ? started.reason : started.error.message}` };
    else {
      const run = started.value as { id: string; state: string; exitCode?: number };
      if (run.state === "running") { await patchWork(ctx, task, { pending: { run: run.id, purpose: "prove" } }); await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 }); later(ctx, task, 10_000); return { taskId: task.id, status: task.status }; }
      verdict = run.exitCode !== 0 ? { ok: true, why: `${ev.check} ${ev.target} exits ${run.exitCode}` } : { ok: false, why: `${ev.check} ${ev.target} passes, so it does not show the defect` };
    }
  } else verdict = { ok: false, why: "unknown kind of evidence" };
  const results = [...prove.results, { finding: prove.finding, ok: verdict.ok, why: verdict.why }];
  // A finding is proven only if every piece of its evidence is; the first failure rejects it.
  const last = prove.evidence + 1 >= finding.evidence.length || !verdict.ok;
  if (last) {
    const own = results.filter((r) => r.finding === prove.finding);
    await keep(ctx, task, "finding", { finding, proven: own.every((r) => r.ok), verifications: own });
  }
  await patchWork(ctx, task, { prove: { finding: last ? prove.finding + 1 : prove.finding, evidence: last ? 0 : prove.evidence + 1, results } });
  await record(ctx, task, "verify", task.status, task.status, `${finding.title}: ${verdict.ok ? "verified" : "rejected"} (${verdict.why}).`);
  await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
  later(ctx, task, 0);
  return { taskId: task.id, status: task.status };
}

function issueBody(task: Task, finding: Finding, verifications: Array<{ why: string }>): string {
  const repo = task.source.conversation, sha = task.work.sha;
  const evidenceText = finding.evidence.map((e, i) => e.kind === "code"
    ? `${i + 1}. [\`${e.path}\` lines ${e.startLine}–${e.endLine}](https://github.com/${repo}/blob/${sha}/${e.path}#L${e.startLine}-L${e.endLine}):\n\n\`\`\`\n${e.quote}\n\`\`\``
    : `${i + 1}. \`${e.check} ${e.target}\` fails at ${sha.slice(0, 12)}.`).join("\n\n");
  return [
    finding.summary, "", `**Severity:** ${finding.severity}`, "", "### Evidence", "", evidenceText, "", "### Suggested fix", "", finding.fix, "",
    "### How this was verified", "", ...verifications.map((v) => `- ${v.why}`), "",
    `Found and verified by Eve2 (task \`${task.id}\`, ${repo}@${sha.slice(0, 12)}): each piece of evidence was re-read or re-run before filing.`,
  ].join("\n");
}

/** File proven findings, most severe first, skipping any already tracked, up to the policy's limit. One issue per step. */
async function filing(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const proven = ((await ctx.db.find(evidence, { taskId: task.id, kind: "finding" })) as Array<{ data: { finding: Finding; proven: boolean; verifications: Array<{ why: string }> } }>)
    .map((r) => r.data).filter((d) => d.proven).sort((a, b) => SEVERITY[a.finding.severity] - SEVERITY[b.finding.severity]);
  const filed: Array<{ title: string; number?: number; url?: string; skipped?: string }> = task.work.filed ?? [];
  const next = proven.find((p) => !filed.some((f) => f.title === p.finding.title));
  const created = filed.filter((f) => f.number).length;
  if (!next || created >= (limits.maxIssues ?? 2)) {
    const rejected = ((await ctx.db.find(evidence, { taskId: task.id, kind: "finding" })) as Array<{ data: { finding: Finding; proven: boolean; verifications: Array<{ why: string }> } }>).filter((r) => !r.data.proven);
    const report = { filed: filed.filter((f) => f.number), skipped: filed.filter((f) => f.skipped), notFiled: proven.filter((p) => !filed.some((f) => f.title === p.finding.title)).map((p) => p.finding.title), rejected: rejected.map((r) => ({ title: r.data.finding.title, why: r.data.verifications.find((v: any) => !v.ok)?.why })), decisions: task.work.decisions };
    await ctx.db.patch(tasks, task.id, { report });
    return move(ctx, task, "completed", "report", `Filed ${report.filed.length} issue(s); ${report.skipped.length} already tracked, ${report.notFiled.length} over the limit, ${report.rejected.length} rejected for lack of proof.`);
  }
  const dup = await invoke(ctx, task, "tracker.items.find", { repository: task.source.conversation, query: next.finding.title }, `${task.id}:dup:${digest(next.finding.title)}`);
  if (dup.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.find", dup);
  const matches = (dup.value as { matches: Array<{ number: number; title: string }> }).matches;
  if (matches.length) {
    await patchWork(ctx, task, { filed: [...filed, { title: next.finding.title, skipped: `already tracked as #${matches[0]!.number}` }] });
  } else {
    const made = await invoke(ctx, task, "tracker.items.create", { repository: task.source.conversation, title: next.finding.title, body: issueBody(task, next.finding, next.verifications) }, `${task.id}:file:${digest(next.finding.title)}`);
    if (made.outcome === "unknown") {
      // Did it land? The tracker is the record: look before trying again.
      await keep(ctx, task, "observation", { n: task.work.decisions, action: "file", summary: `Filing "${next.finding.title}" had an unknown outcome; reconciling with the tracker on the next step.` });
      await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
      later(ctx, task, 5_000);
      return { taskId: task.id, status: task.status };
    }
    if (made.outcome !== "succeeded") return unavailable(ctx, task, "tracker.items.create", made);
    const issue = made.value as { number: number; url: string };
    await keep(ctx, task, "artifact", { kind: "issue", number: issue.number, url: issue.url, title: next.finding.title, severity: next.finding.severity });
    await patchWork(ctx, task, { filed: [...filed, { title: next.finding.title, number: issue.number, url: issue.url }] });
  }
  await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
  later(ctx, task, 0);
  return { taskId: task.id, status: task.status };
}

/* ------------------------------------------------------------------ resolve */

const RESOLVE_GUIDANCE = [
  "You are resolving one work item with a minimal, correct change. Read the item and the code it concerns, reproduce the problem with a test where you can,",
  "make the smallest change that fixes it, and add or adjust a test that fails before your change and passes after it. Run the tests you touched.",
  "Do not change unrelated code, dependencies, lockfiles or CI configuration. Finish only when the tests you name pass.",
].join(" ");
const RESOLVE_SHAPE = `{"summary": "what was wrong and what you changed", "tests": ["path/to/test/file.test.ts"]}`;

async function implementing(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const issue = (await latestSource(ctx, task)) as { number: number; title: string; body: string; comments: Array<{ author: string; body: string }> };
  const result = await loop(ctx, task, {
    objective: `Resolve ${task.source.conversation}#${issue.number}: ${issue.title}\n\n${issue.body}${issue.comments.length ? `\n\nComments:\n${issue.comments.map((c) => `${c.author}: ${c.body}`).join("\n")}` : ""}`,
    guidance: RESOLVE_GUIDANCE, allowed: ["list", "read", "search", "run", "write", "diff"], resultShape: RESOLVE_SHAPE, limits,
  });
  if (!(result && typeof result === "object" && "finished" in result)) return result;
  const finished = result.finished as { summary?: string; tests?: string[] };
  await patchWork(ctx, task, { summary: finished.summary ?? "", tests: (finished.tests ?? []).filter((t) => typeof t === "string"), gate: { index: 0, results: [] } });
  return move(ctx, task, "checking", "decide", `The implementation is ready for Eve's own checks: ${(finished.tests ?? []).length} test file(s) named.`);
}

async function latestSource(ctx: Ctx, task: Task) {
  const rows = (await ctx.db.find(evidence, { taskId: task.id, kind: "source_record" })) as Array<{ at: string; data: unknown }>;
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.data;
}

/** Eve's gate before anything is proposed: a bounded diff, and every named test re-run by Eve, passing. */
async function checking(ctx: Ctx, task: Task) {
  const limits = (await policyFor(ctx, task))!;
  const { tests, gate } = task.work as { tests: string[]; gate: { index: number; results: Array<{ target: string; exitCode: number }> } };
  const back = async (why: string) => {
    const attempts = (task.work.gateAttempts ?? 0) + 1;
    if (attempts > (limits.maxGateAttempts ?? 2)) return halt(ctx, task, "blocked", `My change did not pass my own checks after ${attempts - 1} attempts (${why}). Nothing was proposed.`);
    await keep(ctx, task, "observation", { n: task.work.decisions, action: "gate", summary: `Eve's own check refused the result: ${why}. Fix this, run the tests, and finish again.` });
    await patchWork(ctx, task, { gateAttempts: attempts, gate: null });
    return move(ctx, task, "implementing", "verify", `Eve's own check refused the result (${why}); back to implementation.`);
  };
  if (gate.index === 0 && !task.work.pending) {
    const diff = await invoke(ctx, task, "code.workspace.diff", { workspace: task.work.workspace }, `${task.id}:gate-diff:${task.steps}`);
    if (diff.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.diff", diff);
    const d = diff.value as { files: Array<{ path: string; additions: number; deletions: number }>; patchSha256: string };
    if (!d.files.length) return back("the working copy has no changes");
    if (d.files.length > (limits.maxFiles ?? 5)) return back(`${d.files.length} files changed, more than the ${limits.maxFiles ?? 5} allowed`);
    const forbidden = d.files.filter((f) => (limits.forbiddenPaths ?? []).some((p) => f.path.startsWith(p)));
    if (forbidden.length) return back(`${forbidden.map((f) => f.path).join(", ")} may not be changed`);
    if (!tests.length) return back("no test was named");
    if (!d.files.some((f) => /\.test\.[cm]?[jt]s$/.test(f.path))) return back("no test file was added or changed");
    await keep(ctx, task, "verification", { stage: "diff", files: d.files, patchSha256: d.patchSha256 });
    await patchWork(ctx, task, { diff: d });
  }
  if (task.work.pending) {
    const run = await awaitRun(ctx, task);
    if (!run) return { taskId: task.id, status: task.status };
    const results = [...gate.results, { target: run.target, exitCode: run.exitCode }];
    await patchWork(ctx, task, { pending: null, gate: { index: gate.index + 1, results } });
    if (run.exitCode !== 0) return back(`${run.target} fails when Eve runs it (exit ${run.exitCode})`);
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
    later(ctx, task, 0);
    return { taskId: task.id, status: task.status };
  }
  if (gate.index < tests.length) {
    const started = await invoke(ctx, task, "code.workspace.run", { workspace: task.work.workspace, check: "test", target: tests[gate.index] }, `${task.id}:gate-run:${task.work.gateAttempts ?? 0}:${gate.index}`);
    if (started.outcome !== "succeeded") return unavailable(ctx, task, "code.workspace.run", started);
    await patchWork(ctx, task, { pending: { run: (started.value as { id: string }).id, purpose: "gate" } });
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1 });
    later(ctx, task, (started.value as { state: string }).state === "running" ? 10_000 : 0);
    return { taskId: task.id, status: task.status };
  }
  await keep(ctx, task, "verification", { stage: "tests", results: gate.results });
  return move(ctx, task, "publishing", "verify", `Eve re-ran ${gate.results.length} test file(s); all pass. Proposing the change.`);
}

async function publishing(ctx: Ctx, task: Task) {
  const item = task.work.item as { number: number; title: string; url: string };
  const body = [
    `Refs #${item.number}.`, "", task.work.summary, "", "### Changes", "", ...task.work.diff.files.map((f: any) => `- \`${f.path}\` (+${f.additions} −${f.deletions})`), "",
    "### Checks Eve ran before proposing this", "", ...task.work.gate.results.map((r: any) => `- \`vitest run ${r.target}\`: exit ${r.exitCode}`), "",
    `Proposed by Eve2 (task \`${task.id}\`) from ${task.source.conversation}@${String(task.work.sha).slice(0, 12)}. Not merged: a person decides.`,
  ].join("\n");
  const published = await invoke(ctx, task, "code.changes.publish", {
    workspace: task.work.workspace, branch: `eve/issue-${item.number}-${task.reference.slice(4, 12).toLowerCase()}`,
    title: `Resolve #${item.number}: ${item.title}`.slice(0, 120), body, message: `Resolve #${item.number}: ${item.title}\n\n${task.work.summary}`,
  }, `${task.id}:publish`);
  if (published.outcome === "unknown") {
    // Publishing is idempotent on the branch: asking again returns the pull request if it was opened.
    await record(ctx, task, "wait", task.status, task.status, `Publishing had an unknown outcome (${published.reason}); asking again, which returns the pull request if it was opened.`);
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1, attempts: task.attempts + 1 });
    if (task.attempts + 1 > 3) return halt(ctx, task, "failed", "I could not confirm the pull request after 3 attempts; nothing else was changed.");
    later(ctx, task, 5_000);
    return { taskId: task.id, status: task.status };
  }
  if (published.outcome !== "succeeded") return unavailable(ctx, task, "code.changes.publish", published);
  const pr = published.value as { number: number; url: string; headSha: string };
  await ctx.db.patch(tasks, task.id, { target: { id: String(pr.number), kind: "change" } });
  await keep(ctx, task, "artifact", { kind: "pull_request", ...pr });
  return move(ctx, task, "verifying", "invoke", `Opened pull request #${pr.number}; reading it back.`);
}

async function verifying(ctx: Ctx, task: Task) {
  const got = await invoke(ctx, task, "code.changes.get", { repository: task.source.conversation, number: Number(task.target!.id) }, `${task.id}:verify:${task.steps}`);
  if (got.outcome !== "succeeded") return unavailable(ctx, task, "code.changes.get", got);
  const pr = got.value as { number: number; url: string; state: string; merged: boolean; headSha: string; files: Array<{ path: string }>; checks: Array<{ name: string; status: string; conclusion: string | null }> };
  await keep(ctx, task, "target_record", pr);
  const expected = (task.work.diff.files as Array<{ path: string }>).map((f) => f.path).sort();
  const checks = { open: pr.state === "open", notMerged: !pr.merged, files: JSON.stringify(pr.files.map((f) => f.path).sort()) === JSON.stringify(expected) };
  await keep(ctx, task, "verification", { stage: "pull_request", checks, ci: pr.checks });
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) return halt(ctx, task, "verification_failed", `Pull request #${pr.number} does not match what I prepared (${failed.join(", ")}). I am not reporting it as ready.`);
  await patchWork(ctx, task, { pr: { number: pr.number, url: pr.url, headSha: pr.headSha, ci: pr.checks } });
  return move(ctx, task, "reporting", "verify", `Verified #${pr.number}: open, not merged, and it changes exactly the files Eve checked.`);
}

async function reporting(ctx: Ctx, task: Task) {
  const pr = task.work.pr;
  const ci = pr.ci.length ? pr.ci.map((c: any) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") : "no CI runs reported yet";
  const text = `I proposed a fix in ${pr.url} (not merged).\n\n${task.work.summary}\n\nBefore opening it I re-ran ${task.work.gate.results.map((r: any) => `\`${r.target}\``).join(", ")}: all pass. CI on ${String(pr.headSha).slice(0, 12)} when I checked: ${ci}.`;
  const said = await notify(ctx, task, text, "report");
  if (said && said.outcome !== "succeeded") { later(ctx, task, 5_000); return { taskId: task.id, status: task.status }; }
  await ctx.db.patch(tasks, task.id, { report: { pullRequest: pr, tests: task.work.gate.results, summary: task.work.summary } });
  return move(ctx, task, "completed", "report", `Reported #${pr.number} on the item.`);
}

export const ASSESS_STEPS: Record<string, (ctx: Ctx, task: Task) => Promise<unknown>> = { received, opening: open, preparing, investigating, proving, filing };
export const RESOLVE_STEPS: Record<string, (ctx: Ctx, task: Task) => Promise<unknown>> = { received, opening: open, preparing, implementing, checking, publishing, verifying, reporting };


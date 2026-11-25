/**
 * The operating model's shared steps. Every effect Eve causes goes through invoke(), which records the capability, the
 * idempotency key, the outcome and the host's outbound id; every state change goes through move() or wait(), which
 * record why. A task Eve cannot finish is never dropped: wait() keeps it, with the question, and tells the person
 * where the request came from when there is somewhere to tell them.
 */
import { evidence, executions, tasks } from "./app.js";

export type Ctx = any;
export type Task = { id: string; sourceKey: string; source: { system: string; conversation: string; message: string }; operation?: string; status: string; openQuestion?: string; sourceDigest?: string; intent?: any; plan?: any; planDigest?: string; reference: string; target?: { id: string; kind: string }; attempts: number; steps: number; work?: any; report?: any; createdAt: string; updatedAt: string };

export const WAITING = new Set(["needs_clarification", "needs_approval", "blocked", "failed", "verification_failed"]);
export const TERMINAL = new Set(["completed"]);
export const MAX_STEPS = 60;
export const now = () => new Date().toISOString();

/** FNV-1a over canonical JSON, twice with different seeds: a stable 64-bit digest the guest computes without crypto. */
export function digest(value: unknown): string {
  const text = canonical(value);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
}
export const money = (n: number) => n.toFixed(2);

/* ------------------------------------------------------------------ helpers: every effect leaves a record */

export async function invoke(ctx: Ctx, task: Task, capability: string, input: unknown, idempotencyKey: string) {
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

export async function record(ctx: Ctx, task: Task, kind: string, from: string, to: string, summary: string, detail?: unknown) {
  await ctx.db.insert(executions, { taskId: task.id, seq: task.steps, at: now(), from, to, kind, summary, ...(detail !== undefined ? { detail } : {}) });
}

export async function keep(ctx: Ctx, task: Task, kind: string, data: unknown) {
  await ctx.db.insert(evidence, { taskId: task.id, kind, at: now(), digest: digest(data), data });
}

export async function latest(ctx: Ctx, task: Task, kind: string) {
  const rows = (await ctx.db.find(evidence, { taskId: task.id, kind })) as Array<{ at: string; data: any }>;
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]?.data ?? null;
}

export async function move(ctx: Ctx, task: Task, to: string, kind: string, summary: string, detail?: unknown) {
  await record(ctx, task, kind, task.status, to, summary, detail);
  // Progress clears the count of transient retries.
  if (task.work?.transient) task.work = { ...task.work, transient: 0 };
  await ctx.db.patch(tasks, task.id, { status: to, steps: task.steps + 1, updatedAt: now(), openQuestion: undefined, ...(task.work ? { work: task.work } : {}) });
  ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3 });
  return { taskId: task.id, status: to };
}

/** Stop and ask (or explain), where the request came from when there is somewhere to say it. Eve keeps the task. */
export async function wait(ctx: Ctx, task: Task, to: string, question: string, detail?: unknown) {
  await record(ctx, task, "wait", task.status, to, question, detail);
  // A blocked task remembers where it stopped, so an operator's resume continues there.
  if (to === "blocked" && task.work) task.work = { ...task.work, resumeAt: task.status };
  await ctx.db.patch(tasks, task.id, { status: to, openQuestion: question, steps: task.steps + 1, updatedAt: now(), ...(task.work ? { work: task.work } : {}) });
  await notify(ctx, { ...task, steps: task.steps + 1 }, question, `ask:${task.steps}`);
  return { taskId: task.id, status: to, question };
}

/** Tell the requester, in the system the request came from: a conversation reply, an issue comment, or nothing (operator). */
export async function notify(ctx: Ctx, task: Task, text: string, key: string) {
  const { system, conversation, message } = task.source;
  if (system === "operator") return null;
  if (system === "tracker") return invoke(ctx, task, "tracker.items.comment", { repository: conversation, number: Number(message), operation: `${task.id}:${key}`, body: text }, `${task.id}:${key}`);
  return invoke(ctx, task, "conversation.messages.reply", { conversation, message, text }, `${task.id}:${key}`);
}

export const halt = (ctx: Ctx, task: Task, to: string, why: string) => wait(ctx, task, to, why);

/** Whether an outcome may clear up by itself: a provider that is down or restarting, an unknown outcome, a concurrent attempt. */
export const transient = (result: any) => result.outcome === "unknown"
  || (result.outcome === "failed" && ["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT"].includes(result.error?.code))
  || (result.outcome === "refused" && result.error?.code === "CONFLICT");
export const MAX_TRANSIENT = 6;

/**
 * A capability that did not answer usefully. A transient failure is retried later, a bounded number of times, the step
 * re-reading what it needs (it never assumes the earlier attempt did nothing); anything else, or too many, blocks with
 * exactly which capability and why. The task is kept either way.
 */
export async function unavailable(ctx: Ctx, task: Task, capability: string, result: any) {
  const why = result.outcome === "unknown" ? `it did not answer (${result.reason})` : `${result.error.code}: ${result.error.message}`;
  const tries = (task.work?.transient ?? 0) + 1;
  if (transient(result) && tries <= MAX_TRANSIENT) {
    task.work = { ...(task.work ?? {}), transient: tries };
    await record(ctx, task, "wait", task.status, task.status, `${capability}: ${why}. Trying this step again (${tries} of ${MAX_TRANSIENT}).`);
    await ctx.db.patch(tasks, task.id, { steps: task.steps + 1, updatedAt: now(), work: task.work });
    ctx.afterCommit.jobs.enqueue("eve.advance", { taskId: task.id }, { maxAttempts: 3, runAt: new Date(Date.now() + 5_000 * tries).toISOString() });
    return { taskId: task.id, status: task.status, retrying: tries };
  }
  return wait(ctx, task, "blocked", `I couldn't use ${capability}: ${why}. Nothing was entered; I'll continue when it is available.`);
}

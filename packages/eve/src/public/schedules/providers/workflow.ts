import { createHash, randomUUID } from "node:crypto";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { ContextContainer, loadContext } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { workflowScheduleWorkflowReference } from "#execution/workflow-references.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { getHookByToken, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import type {
  ScheduleExpression,
  ScheduleProvider,
  ScheduleRecord,
} from "#public/schedules/subscription.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import {
  nextScheduleOccurrence,
  WORKFLOW_SCHEDULE_PROVIDER_KIND,
  WORKFLOW_SCHEDULE_TOKEN_PREFIX,
  workflowScheduleToken,
} from "#runtime/schedules/durable/state.js";
import type {
  WorkflowScheduleMessage,
  WorkflowScheduleMetadata,
  WorkflowScheduleVersion,
} from "#runtime/schedules/durable/types.js";
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";

const CHANGE_TIMEOUT_MS = 30_000;
const CHANGE_POLL_MS = 100;
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/**
 * A durable schedule provider that runs on eve's Workflow world, so dynamic
 * schedules work under `eve start` with the local or Postgres world. Each
 * schedule is one durable workflow run that sleeps until its next occurrence;
 * schedules survive restarts, and an occurrence due during downtime runs once
 * when the server is back. Changing a schedule replaces its run.
 */
export function workflowScheduleProvider(): ScheduleProvider {
  return {
    kind: WORKFLOW_SCHEDULE_PROVIDER_KIND,
    validateExpression,

    async create(context, schedule) {
      const token = tokenFor(context, schedule.name);
      const current = await readCurrent(token);
      if (current !== undefined) {
        if (current.createOperationId === context.operationId) return current.record;
        throw new Error(`Schedule ${JSON.stringify(schedule.name)} already exists.`);
      }
      const now = Date.now();
      const expression = normalizeExpression(schedule.expression);
      const record: ScheduleRecord = {
        createdAt: now,
        expression,
        name: schedule.name,
        scheduleId: `wf_${createHash("sha256").update(`${token}:${randomUUID()}`).digest("hex").slice(0, 40)}`,
        state: nextScheduleOccurrence(expression, new Date(now)) === null ? "completed" : "active",
        updatedAt: now,
      };
      await startWorkflowOnCurrentDeployment(workflowScheduleWorkflowReference, [
        {
          collection: context.collection,
          createOperationId: context.operationId,
          lastOperationId: context.operationId,
          namespace: context.namespace,
          payload: schedule.payload,
          record,
          serializedContext: await currentAgentContext(),
          token,
        } satisfies WorkflowScheduleVersion,
      ]);
      await waitForChange(token, (metadata) => metadata?.record.scheduleId === record.scheduleId);
      return record;
    },

    async list(context, query) {
      const records = await listRecords(context);
      const start = decodeCursor(query.cursor);
      const limit = normalizeLimit(query.limit);
      const data = records.slice(start, start + limit);
      const next = start + data.length;
      return { cursor: next < records.length ? String(next) : null, data };
    },

    async get(context, name) {
      return (await readCurrent(tokenFor(context, name)))?.record ?? null;
    },

    async update(context, name, patch) {
      return await replace(context, name, (current) => {
        const expression =
          patch.expression === undefined
            ? current.record.expression
            : normalizeExpression(patch.expression);
        const reopened =
          current.record.state === "completed" &&
          patch.expression !== undefined &&
          nextScheduleOccurrence(expression, new Date()) !== null;
        return {
          payload: patch.payload === undefined ? current.payload : patch.payload,
          record: {
            ...current.record,
            expression,
            state: reopened ? "active" : current.record.state,
          },
        };
      });
    },

    async enable(context, name) {
      return await replace(context, name, (current) => ({
        payload: current.payload,
        record: { ...current.record, state: "active" },
      }));
    },

    async disable(context, name) {
      return await replace(context, name, (current) => ({
        payload: current.payload,
        record: { ...current.record, state: "inactive" },
      }));
    },

    async invoke(context, name) {
      const current = await requireCurrent(tokenFor(context, name), name);
      if (current.record.state === "completed") {
        throw new Error(`Completed schedule ${JSON.stringify(name)} cannot be invoked.`);
      }
      if (context.target.deliver === undefined) {
        throw new Error("This schedule provider can only invoke a schedule from inside the agent.");
      }
      await context.target.deliver({
        occurrence: {
          executionId: `manual_${createHash("sha256").update(context.operationId).digest("base64url")}`,
          name: current.record.name,
          scheduleId: current.record.scheduleId,
          scheduledAt: new Date().toISOString(),
        },
        payload: current.payload,
      });
    },

    async delete(context, name) {
      const token = tokenFor(context, name);
      const current = await readCurrent(token);
      if (current === undefined) return false;
      await send(token, { kind: "delete" });
      await waitForChange(token, (metadata) => metadata === undefined);
      return true;
    },
  };
}

async function replace(
  context: ScheduleProviderContext,
  name: string,
  change: (
    current: WorkflowScheduleMetadata,
  ) => Pick<WorkflowScheduleVersion, "payload" | "record">,
): Promise<ScheduleRecord> {
  const token = tokenFor(context, name);
  const current = await requireCurrent(token, name);
  if (current.lastOperationId === context.operationId) return current.record;
  const changed = change(current);
  const version: WorkflowScheduleVersion = {
    ...current,
    lastOperationId: context.operationId,
    payload: changed.payload,
    record: { ...changed.record, updatedAt: Date.now() },
    serializedContext: await currentAgentContext(),
  };
  await send(token, { kind: "replace", version });
  await waitForChange(token, (metadata) => metadata?.lastOperationId === context.operationId);
  return version.record;
}

async function send(token: string, message: WorkflowScheduleMessage): Promise<void> {
  await resumeHook(token, message);
}

function tokenFor(context: ScheduleProviderContext, name: string): string {
  return workflowScheduleToken({
    collection: context.collection,
    name,
    namespace: context.namespace,
  });
}

async function readCurrent(token: string): Promise<WorkflowScheduleMetadata | undefined> {
  let hook;
  try {
    hook = await getHookByToken(token);
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  if (!LIVE_RUN_STATUSES.has(await getRun(hook.runId).status)) return undefined;
  return (await hook.metadata) as WorkflowScheduleMetadata;
}

async function requireCurrent(token: string, name: string): Promise<WorkflowScheduleMetadata> {
  const current = await readCurrent(token);
  if (current === undefined) throw new Error(`Schedule ${JSON.stringify(name)} was not found.`);
  return current;
}

async function waitForChange(
  token: string,
  done: (metadata: WorkflowScheduleMetadata | undefined) => boolean,
): Promise<void> {
  const deadline = Date.now() + CHANGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (done(await readCurrent(token))) return;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, CHANGE_POLL_MS));
  }
  throw new Error(
    `The schedule change did not take effect within ${CHANGE_TIMEOUT_MS / 1000}s. Check that the Workflow world is processing runs.`,
  );
}

async function listRecords(context: ScheduleProviderContext): Promise<ScheduleRecord[]> {
  const world = await getWorld();
  const tokens = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await world.hooks.list({ pagination: { cursor, limit: 100 } });
    for (const hook of page.data) {
      if (hook.token.startsWith(WORKFLOW_SCHEDULE_TOKEN_PREFIX)) tokens.add(hook.token);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  const records: ScheduleRecord[] = [];
  for (const token of tokens) {
    const current = await readCurrent(token);
    if (current?.collection === context.collection && current.namespace === context.namespace) {
      records.push(current.record);
    }
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function currentAgentContext(): Promise<Record<string, unknown>> {
  const bundle = requireCompiledBundle(loadContext());
  const ctx = new ContextContainer({ localDevRequest: undefined });
  ctx.set(SessionAgentKey, await compiledSessionAgent(bundle));
  return serializeContext(ctx);
}

function validateExpression(expression: ScheduleExpression): void {
  try {
    nextScheduleOccurrence(expression, new Date());
  } catch (error) {
    throw new Error(
      `Invalid schedule expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeExpression(expression: ScheduleExpression): ScheduleExpression {
  if (expression.type === "cron") {
    const normalized: { type: "cron"; cron: string; timezone?: string; jitter?: number } = {
      cron: expression.cron.trim().replace(/\s+/gu, " "),
      type: "cron",
    };
    if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
    if (expression.jitter !== undefined) normalized.jitter = expression.jitter;
    return normalized;
  }
  const normalized: { type: "single"; at: string; timezone?: string } = {
    at: expression.at,
    type: "single",
  };
  if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Schedule list limit must be an integer from 1 through 100.");
  }
  return limit;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid schedule cursor.");
  return value;
}

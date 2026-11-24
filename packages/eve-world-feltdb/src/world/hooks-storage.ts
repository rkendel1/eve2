/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/hooks-storage.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { HookNotFoundError } from "@workflow/errors";
import type {
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from "@workflow/world";
import { isTerminalWorkflowRunStatus } from "@workflow/world";
import { DEFAULT_RESOLVE_DATA_OPTION } from "./config.js";
import type { WorldDatabase } from "./database.js";
import { assertSafeEntityId } from "./ids.js";
import { filterHookData } from "./filters.js";
import { entityCursor, Store } from "./store.js";
export function createHooksStorage(database: WorldDatabase, tag?: string): Storage["hooks"] {
  const store = new Store(database, tag);
  async function isAvailable(hook: Hook): Promise<boolean> {
    if (await store.getDisposal(hook.hookId)) return false;
    if (hook.tokenRetentionUntil && new Date(hook.tokenRetentionUntil).getTime() > Date.now()) {
      return true;
    }
    const run = await store.getRunAnyTag(hook.runId);
    return run !== null && !isTerminalWorkflowRunStatus(run.run.status);
  }
  const withDefaults = (hook: Hook): Hook => ({
    ...hook,
    isWebhook: hook.isWebhook ?? true,
  });
  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId("hookId", hookId);
    const hook = await database.snapshot(async () => {
      const found = await store.getHook(hookId);
      return found && (await isAvailable(found)) ? found : null;
    });
    if (!hook) throw new HookNotFoundError(hookId);
    return filterHookData(withDefaults(hook), params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION);
  }
  async function getByToken(token: string): Promise<Hook> {
    const hook = await database.snapshot(async () => {
      const owner = await store.getTokenOwner(token);
      const found = owner ? await store.getHook(owner.hookId) : null;
      return found && found.token === token && (await isAvailable(found)) ? found : null;
    });
    if (!hook) throw new HookNotFoundError(token);
    return withDefaults(hook);
  }
  async function list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
    const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    const sortOrder: "asc" | "desc" = params.pagination?.sortOrder ?? "asc";
    const limit = Math.max(1, params.pagination?.limit ?? 20);
    const data: Hook[] = [];
    let hasMore = false;
    await database.snapshot(async () => {
      for await (const hook of store.hooksInOrder({
        runId: params.runId || undefined,
        cursor: params.pagination?.cursor,
        sortOrder,
      })) {
        if (!(await isAvailable(hook))) continue;
        if (data.length === limit) {
          hasMore = true;
          break;
        }
        data.push(hook);
      }
    });
    const last = data.at(-1);
    return {
      data: data.map((hook) => filterHookData(hook, resolveData)),
      cursor: last ? entityCursor(last.createdAt, last.hookId) : null,
      hasMore,
    };
  }
  return { get, getByToken, list };
}

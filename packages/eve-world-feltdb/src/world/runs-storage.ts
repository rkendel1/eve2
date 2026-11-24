/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/runs-storage.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { WorkflowRunNotFoundError } from "@workflow/errors";
import type {
  AttributeChange,
  ExperimentalSetAttributesResult,
  ListWorkflowRunsParams,
  PaginatedResponse,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from "@workflow/world";
import {
  applyAttributeChanges,
  isTerminalWorkflowRunStatus,
  validateAttributeChanges,
} from "@workflow/world";
import { DEFAULT_RESOLVE_DATA_OPTION } from "./config.js";
import type { WorldDatabase } from "./database.js";
import { assertSafeEntityId } from "./ids.js";
import { filterRunData } from "./filters.js";
import { RUN_STATUS_POLL_INTERVAL_MS, waitForRunTerminalSignal } from "./run-status-signal.js";
import { entityCursor, Store } from "./store.js";
export interface LocalListWorkflowRunsParams extends ListWorkflowRunsParams {
  ownTagOnly?: boolean;
}
export interface LocalRunsStorage {
  get: Storage["runs"]["get"];
  waitForTerminalStatus: NonNullable<Storage["runs"]["waitForTerminalStatus"]>;
  getMany: NonNullable<Storage["runs"]["getMany"]>;
  list: {
    (
      params: LocalListWorkflowRunsParams & {
        resolveData: "none";
      },
    ): Promise<PaginatedResponse<WorkflowRunWithoutData>>;
    (
      params?: LocalListWorkflowRunsParams & {
        resolveData?: "all";
      },
    ): Promise<PaginatedResponse<WorkflowRun>>;
    (
      params?: LocalListWorkflowRunsParams,
    ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>>;
  };
  experimentalSetAttributes(
    runId: string,
    changes: AttributeChange[],
    options?: {
      allowReservedAttributes?: boolean;
    },
  ): Promise<ExperimentalSetAttributesResult>;
}
export function createRunsStorage(database: WorldDatabase, tag?: string): LocalRunsStorage {
  const store = new Store(database, tag);
  const get = (async (id: string, params?: any) => {
    assertSafeEntityId("runId", id);
    const row = await store.getRun(id);
    if (!row) throw new WorkflowRunNotFoundError(id);
    return filterRunData(row.run, params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION);
  }) as Storage["runs"]["get"];
  return {
    get,
    waitForTerminalStatus: (async (id: string, params?: any) => {
      const deadline = Date.now() + (params?.timeoutMs ?? 0);
      while (true) {
        const run = await get(id, params);
        if (isTerminalWorkflowRunStatus(run.status)) return run;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || params?.signal?.aborted) return run;
        await waitForRunTerminalSignal(
          id,
          Math.min(remainingMs, RUN_STATUS_POLL_INTERVAL_MS),
          params?.signal,
        );
      }
    }) as NonNullable<Storage["runs"]["waitForTerminalStatus"]>,
    getMany: (async (ids: readonly string[], params?: any) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return Promise.all(
        ids.map(async (id) => {
          const row = await store.getRun(id);
          return row ? filterRunData(row.run, resolveData) : null;
        }),
      );
    }) as NonNullable<Storage["runs"]["getMany"]>,
    list: (async (params?: LocalListWorkflowRunsParams) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const sortOrder = params?.pagination?.sortOrder ?? "desc";
      const limit = Math.max(1, params?.pagination?.limit ?? 200);
      let statuses: string[] | undefined;
      if (params?.status !== undefined) {
        statuses = Array.isArray(params.status) ? params.status : [params.status];
        if (statuses.length === 0) {
          return { data: [], cursor: null, hasMore: false };
        }
      }
      const { data, hasMore } = await store.pageRuns({
        ownTagOnly: params?.ownTagOnly === true,
        workflowName: params?.workflowName,
        statuses,
        cursor: params?.pagination?.cursor,
        sortOrder,
        limit,
      });
      const last = data.at(-1);
      return {
        data: data.map((run) => filterRunData(run, resolveData)),
        cursor: last ? entityCursor(last.createdAt, last.runId) : null,
        hasMore,
      };
    }) as LocalRunsStorage["list"],
    experimentalSetAttributes: async (runId, changes, options) => {
      assertSafeEntityId("runId", runId);
      return database.transact(async (unit) => {
        const bound = store.in(unit);
        const row = await bound.getRun(runId);
        if (!row) throw new WorkflowRunNotFoundError(runId);
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(row.run.attributes ?? {}),
          allowReservedAttributes: options?.allowReservedAttributes,
        });
        const attributes = applyAttributeChanges(row.run.attributes, changes);
        await bound.updateRun({
          ...row.run,
          attributes,
          updatedAt: new Date(),
        });
        return { attributes };
      });
    },
  };
}

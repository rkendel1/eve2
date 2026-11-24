/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/steps-storage.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { StepWithoutData, Storage } from "@workflow/world";
import { DEFAULT_RESOLVE_DATA_OPTION } from "./config.js";
import type { WorldDatabase } from "./database.js";
import { assertSafeEntityId } from "./ids.js";
import { filterStepData } from "./filters.js";
import { entityCursor, Store } from "./store.js";
export function createStepsStorage(database: WorldDatabase, tag?: string): Storage["steps"] {
  const store = new Store(database, tag);
  return {
    get: (async (runId: string, stepId: string, params?: any) => {
      assertSafeEntityId("runId", runId);
      assertSafeEntityId("stepId", stepId);
      const step = await store.getStep(runId, stepId);
      if (!step) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }
      return filterStepData(step, params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION);
    }) as Storage["steps"]["get"],
    list: (async (params: any) => {
      assertSafeEntityId("runId", params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const sortOrder: "asc" | "desc" = params.pagination?.sortOrder ?? "desc";
      const limit = Math.max(1, params.pagination?.limit ?? 20);
      const { data, hasMore } = await store.pageSteps({
        runId: params.runId,
        cursor: params.pagination?.cursor,
        sortOrder,
        limit,
      });
      const last = data.at(-1);
      return {
        data:
          resolveData === "none"
            ? (data.map((step) => filterStepData(step, "none")) as StepWithoutData[])
            : data,
        cursor: last ? entityCursor(last.createdAt, last.stepId) : null,
        hasMore,
      };
    }) as Storage["steps"]["list"],
  };
}

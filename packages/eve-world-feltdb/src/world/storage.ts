/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/index.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { Storage } from "@workflow/world";
import type { WorldDatabase } from "./database.js";
import { createEventsStorage } from "./events-storage.js";
import { createHooksStorage } from "./hooks-storage.js";
import { createRunsStorage, type LocalRunsStorage } from "./runs-storage.js";
import { createSnapshotsStorage } from "./snapshots-storage.js";
import { createStepsStorage } from "./steps-storage.js";
export type LocalStorage = Omit<Storage, "runs"> & {
  runs: LocalRunsStorage;
  clearCache(): void;
};
export function createStorage(database: WorldDatabase, tag?: string): LocalStorage {
  return {
    runs: createRunsStorage(database, tag),
    steps: createStepsStorage(database, tag),
    events: createEventsStorage(database, tag),
    hooks: createHooksStorage(database, tag),
    experimental_snapshots: createSnapshotsStorage(database),
    clearCache: () => {},
  };
}

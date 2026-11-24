/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/snapshots-storage.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { SnapshotMetadata } from "@workflow/world";
import { decodeSnapshotEnvelope, encodeSnapshotEnvelope } from "@workflow/world";
import type { WorldDatabase } from "./database.js";
import { assertSafeEntityId } from "./ids.js";
import { Store } from "./store.js";
export function createSnapshotsStorage(database: WorldDatabase) {
  const store = new Store(database, undefined);
  return {
    async save(runId: string, data: Uint8Array, metadata: SnapshotMetadata): Promise<void> {
      assertSafeEntityId("runId", runId);
      await database.transact(async (unit) => {
        store.in(unit).putSnapshot(runId, encodeSnapshotEnvelope(metadata, data));
      });
    },
    async load(runId: string): Promise<{
      data: Uint8Array;
      metadata: SnapshotMetadata;
    } | null> {
      assertSafeEntityId("runId", runId);
      const envelope = await store.getSnapshot(runId);
      if (!envelope) return null;
      return decodeSnapshotEnvelope(envelope);
    },
    async delete(runId: string): Promise<void> {
      assertSafeEntityId("runId", runId);
      await database.transact(async (unit) => {
        await store.in(unit).deleteSnapshot(runId);
      });
    },
  };
}

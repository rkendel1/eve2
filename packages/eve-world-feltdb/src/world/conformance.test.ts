import { createFeltDB } from "@feltdb/core";
import { IN_BAND_SEQ_AT_RUN_CREATION, type Storage } from "@workflow/world";
import { atomicStartHookConformance } from "@workflow/world/test-support/atomic-start-hook-conformance.js";
import { inBandFenceConformance } from "@workflow/world/test-support/in-band-fence-conformance.js";
import { ulid } from "ulid";
import { vi } from "vitest";
import { feltdbRecordPayloads } from "../payload/record-store.js";
import { WorldDatabase } from "./database.js";
import { createStorage } from "./storage.js";
import { FELTDB_WORLD_CAPABILITIES } from "./world.js";

function freshStorage() {
  const db = createFeltDB({ memory: true, namespace: `conformance-${crypto.randomUUID()}` });
  const database = new WorldDatabase({ db, payloads: feltdbRecordPayloads({ db }) });
  const storage = createStorage(database);
  sameData.set(storage.events, database);
  return storage;
}

const sameData = new WeakMap<object, WorldDatabase>();

function secondEvents(first: Storage["events"]): Storage["events"] {
  const database = sameData.get(first);
  if (!database) throw new Error("unknown first storage");
  return createStorage(new WorldDatabase({ db: database.db, payloads: database.payloads })).events;
}

inBandFenceConformance({
  name: "FeltDB World",
  events: () => freshStorage().events,
  capabilities: () => FELTDB_WORLD_CAPABILITIES,
  newRunId: () => `wrun_${ulid()}`,
  atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
  secondEvents,
});

let clockOffset = 0;
atomicStartHookConformance({
  name: "FeltDB World",
  storage: () => freshStorage(),
  capabilities: () => FELTDB_WORLD_CAPABILITIES,
  newRunId: () => `wrun_${ulid()}`,
  secondEvents,
  advanceClock: (ms) => {
    clockOffset = ms === 0 ? 0 : clockOffset + ms;
    if (clockOffset === 0) vi.useRealTimers();
    else vi.useFakeTimers({ now: Date.now() + ms, toFake: ["Date"] });
  },
  retentionReadsAdvanceClock: true,
});

import { createFeltDB } from "@feltdb/core";
import { EntityConflictError, InBandSupersededError } from "@workflow/errors";
import type { Storage } from "@workflow/world";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { feltdbRecordPayloads } from "../payload/record-store.js";
import { WorldDatabase } from "./database.js";
import { createStorage } from "./storage.js";

function world(tag?: string) {
  const db = createFeltDB({ memory: true, namespace: crypto.randomUUID() });
  const database = new WorldDatabase({ db, payloads: feltdbRecordPayloads({ db }) });
  const storage: Storage = createStorage(database, tag);
  return { database, storage };
}

const runCreation = {
  eventType: "run_created" as const,
  eventData: {
    deploymentId: "dpl_test",
    workflowName: "workflow//greet",
    input: new Uint8Array([1, 2, 3]),
  },
};

async function createRun(storage: Storage): Promise<string> {
  const result = await storage.events.create(null, runCreation);
  return result.run!.runId;
}

async function positions(storage: Storage, runId: string): Promise<number[]> {
  const page = await storage.events.list({ runId, pagination: { limit: 1000 } });
  return page.data.map((event) => Number(event.eventId.slice("evnt_".length)));
}

const dense = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("FeltDB World storage", () => {
  it("records a run's lifecycle at gap-free positions", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    await storage.events.create(runId, { eventType: "run_started" });
    await storage.events.create(runId, {
      eventType: "step_created",
      correlationId: "step_1",
      eventData: { stepName: "greet", input: new Uint8Array([4]) },
    });
    await storage.events.create(runId, { eventType: "step_started", correlationId: "step_1" });
    const completed = await storage.events.create(runId, {
      eventType: "step_completed",
      correlationId: "step_1",
      eventData: { result: new Uint8Array([5]) },
    });
    expect(completed.step?.status).toBe("completed");
    const finished = await storage.events.create(runId, {
      eventType: "run_completed",
      eventData: { output: new Uint8Array([6]) },
    });
    expect(finished.run?.status).toBe("completed");

    expect(await positions(storage, runId)).toEqual(dense(6));
    const listed = await storage.events.list({ runId });
    expect(listed.data.map((event) => event.eventType)).toEqual([
      "run_created",
      "run_started",
      "step_created",
      "step_started",
      "step_completed",
      "run_completed",
    ]);
    const third = listed.data[2]!;
    expect(await storage.events.get(runId, third.eventId)).toMatchObject({
      eventType: "step_created",
      correlationId: "step_1",
    });
    expect((await storage.runs.get(runId)).status).toBe("completed");
    expect((await storage.steps.get(runId, "step_1")).output).toEqual(new Uint8Array([5]));
  });

  it("preloads the run_started it just wrote", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    const started = await storage.events.create(runId, { eventType: "run_started" });
    expect(
      (started as { events?: Array<{ eventType: string }> }).events?.map(
        (event) => event.eventType,
      ),
    ).toEqual(["run_created", "run_started"]);
  });

  it("refuses a second run_created for the same run", async () => {
    const { storage } = world();
    const id = `wrun_${ulid()}`;
    await storage.events.create(id, runCreation);
    await expect(storage.events.create(id, runCreation)).rejects.toBeInstanceOf(
      EntityConflictError,
    );
    expect(await positions(storage, id)).toEqual([1]);
  });

  it("refuses a stale in-band write and appends nothing", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    const started = await storage.events.create(
      runId,
      { eventType: "run_started" },
      { inBand: true, expectedSeqInBand: 1 },
    );
    expect(started.allocated).toBe(1);
    await expect(
      storage.events.create(
        runId,
        {
          eventType: "step_created",
          correlationId: "step_1",
          eventData: { stepName: "greet", input: new Uint8Array() },
        },
        { inBand: true, expectedSeqInBand: 1 },
      ),
    ).rejects.toBeInstanceOf(InBandSupersededError);
    expect(await positions(storage, runId)).toEqual([1, 2]);
    const listed = await storage.events.list({ runId });
    expect(listed.snapshot).toEqual({ seq: 2, seqInBand: 2 });
  });

  it("gives concurrent creates on one run dense positions", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    await storage.events.create(runId, { eventType: "run_started" });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storage.events.create(runId, {
          eventType: "step_created",
          correlationId: `step_${index}`,
          eventData: { stepName: "greet", input: new Uint8Array([index]) },
        }),
      ),
    );
    expect(await positions(storage, runId)).toEqual(dense(22));
    const steps = await storage.steps.list({ runId, pagination: { limit: 100 } });
    expect(steps.data).toHaveLength(20);
  });

  it("keeps a hook token unique across runs", async () => {
    const { storage } = world();
    const first = await createRun(storage);
    const second = await createRun(storage);
    for (const runId of [first, second])
      await storage.events.create(runId, { eventType: "run_started" });
    const created = await storage.events.create(first, {
      eventType: "hook_created",
      correlationId: "hook_a",
      eventData: { token: "shared-token" },
    });
    expect(created.hook?.token).toBe("shared-token");
    const conflict = await storage.events.create(second, {
      eventType: "hook_created",
      correlationId: "hook_b",
      eventData: { token: "shared-token" },
    });
    expect(conflict.event?.eventType).toBe("hook_conflict");
    expect(conflict.hook).toBeUndefined();
    expect((await storage.hooks.getByToken("shared-token")).hookId).toBe("hook_a");

    await storage.events.create(first, {
      eventType: "run_completed",
      eventData: { output: new Uint8Array() },
    });
    const third = await createRun(storage);
    await storage.events.create(third, { eventType: "run_started" });
    const taken = await storage.events.create(third, {
      eventType: "hook_created",
      correlationId: "hook_c",
      eventData: { token: "shared-token" },
    });
    expect(taken.hook?.hookId).toBe("hook_c");
    expect((await storage.hooks.getByToken("shared-token")).runId).toBe(third);
  });

  it("records a hook resume once per resumeId", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    await storage.events.create(runId, { eventType: "run_started" });
    await storage.events.create(runId, {
      eventType: "hook_created",
      correlationId: "hook_a",
      eventData: { token: "resume-token" },
    });
    const received = () =>
      storage.events.create(
        runId,
        {
          eventType: "hook_received",
          correlationId: "hook_a",
          eventData: { payload: new Uint8Array([9]) },
        },
        { resumeId: "resume_1", resumePayloadDigest: "digest-1" },
      );
    const first = await received();
    const second = await received();
    expect(second.event?.eventId).toBe(first.event?.eventId);
    expect(await positions(storage, runId)).toEqual(dense(4));
    await expect(
      storage.events.create(
        runId,
        {
          eventType: "hook_received",
          correlationId: "hook_a",
          eventData: { payload: new Uint8Array([8]) },
        },
        { resumeId: "resume_1", resumePayloadDigest: "digest-2" },
      ),
    ).rejects.toBeInstanceOf(EntityConflictError);
  });

  it("refuses new entities on a terminal run", async () => {
    const { storage } = world();
    const runId = await createRun(storage);
    await storage.events.create(runId, { eventType: "run_started" });
    await storage.events.create(runId, { eventType: "run_cancelled" });
    await expect(
      storage.events.create(runId, {
        eventType: "step_created",
        correlationId: "step_1",
        eventData: { stepName: "greet", input: new Uint8Array() },
      }),
    ).rejects.toBeInstanceOf(EntityConflictError);
    await expect(
      storage.events.create(runId, {
        eventType: "hook_created",
        correlationId: "hook_a",
        eventData: { token: "late" },
      }),
    ).rejects.toBeInstanceOf(EntityConflictError);
    const again = await storage.events.create(runId, { eventType: "run_cancelled" });
    expect(again.event?.eventType).toBe("run_cancelled");
    expect(await positions(storage, runId)).toEqual(dense(4));
  });

  it("pages runs, steps and hooks without gaps or repeats", async () => {
    const { storage } = world();
    const runIds: string[] = [];
    for (let index = 0; index < 5; index++) runIds.push(await createRun(storage));
    const runId = runIds[0]!;
    await storage.events.create(runId, { eventType: "run_started" });
    for (let index = 0; index < 5; index++) {
      await storage.events.create(runId, {
        eventType: "step_created",
        correlationId: `step_${index}`,
        eventData: { stepName: "greet", input: new Uint8Array() },
      });
      await storage.events.create(runId, {
        eventType: "hook_created",
        correlationId: `hook_${index}`,
        eventData: { token: `token_${index}` },
      });
    }

    const collect = async <T>(
      list: (
        cursor: string | undefined,
      ) => Promise<{ data: T[]; cursor: string | null; hasMore: boolean }>,
    ): Promise<T[]> => {
      const all: T[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await list(cursor);
        all.push(...page.data);
        if (!page.hasMore) return all;
        cursor = page.cursor ?? undefined;
      }
    };

    const runs = await collect((cursor) => storage.runs.list({ pagination: { limit: 2, cursor } }));
    expect(runs.map((run) => run.runId)).toEqual([...runIds].reverse());
    const ascending = await collect((cursor) =>
      storage.runs.list({ pagination: { limit: 2, cursor, sortOrder: "asc" } }),
    );
    expect(ascending.map((run) => run.runId)).toEqual(runIds);
    const running = await storage.runs.list({ status: "running" });
    expect(running.data.map((run) => run.runId)).toEqual([runId]);
    expect((await storage.runs.list({ status: [] })).data).toEqual([]);

    const steps = await collect((cursor) =>
      storage.steps.list({ runId, pagination: { limit: 2, cursor, sortOrder: "asc" } }),
    );
    expect(steps.map((step) => step.stepId)).toEqual([0, 1, 2, 3, 4].map((i) => `step_${i}`));

    const hooks = await collect((cursor) =>
      storage.hooks.list({ runId, pagination: { limit: 2, cursor } }),
    );
    expect(hooks.map((hook) => hook.hookId)).toEqual([0, 1, 2, 3, 4].map((i) => `hook_${i}`));

    const events = await collect((cursor) =>
      storage.events.list({ runId, pagination: { limit: 3, cursor } }),
    );
    expect(events.map((event) => Number(event.eventId.slice("evnt_".length)))).toEqual(dense(12));
  });
});

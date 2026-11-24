/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/store.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { Event, Hook, PaginatedResponse, Step, Wait, WorkflowRun } from "@workflow/world";
import { eventIdToSlot, slotToEventId } from "@workflow/world";
import { decode, encode } from "./codec.js";
import {
  COLLECTIONS,
  type FeltRecord,
  joinKey,
  keyPart,
  type Unit,
  type WorldDatabase,
} from "./database.js";

const EVENT_READ_BATCH = 64;

export interface RunRow {
  run: WorkflowRun;
  tag: string | null;
  seq: number;
  seqInBand: number;
}

export interface TokenOwner {
  hookId: string;
  runId: string;
  retentionUntil: number | null;
}

export interface HookResume {
  hookId: string;
  seq: number;
  payloadDigest: string | null;
}

const visibleTo = (tag: string | undefined, rowTag: unknown) =>
  rowTag === null || rowTag === undefined ? true : tag !== undefined && rowTag === tag;

const strictlyUntagged = (tag: string | undefined, rowTag: unknown) =>
  tag === undefined ? rowTag === null || rowTag === undefined : visibleTo(tag, rowTag);

export class Store {
  readonly database: WorldDatabase;
  readonly tag: string | undefined;
  readonly unit: Unit | undefined;

  constructor(database: WorldDatabase, tag: string | undefined, unit?: Unit) {
    this.database = database;
    this.tag = tag;
    this.unit = unit;
  }

  in(unit: Unit): Store {
    return new Store(this.database, this.tag, unit);
  }

  #writer(): Unit {
    if (!this.unit) throw new Error("a World write must run inside a transaction");
    return this.unit;
  }

  async #get(
    collection: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
    id: string,
  ): Promise<FeltRecord | null> {
    return this.unit ? this.unit.get(collection, id) : this.database.read(collection, id);
  }

  async #doc<T>(record: FeltRecord, field: "doc" | "envelope" | "data" = "doc"): Promise<T> {
    return decode<T>(await this.database.internalize(record, field));
  }

  async #runRow(record: FeltRecord): Promise<RunRow> {
    return {
      run: await this.#doc<WorkflowRun>(record),
      tag: (record.tag as string | null | undefined) ?? null,
      seq: Number(record.seq ?? 0),
      seqInBand: Number(record.seqInBand ?? 1),
    };
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const record = await this.#get(COLLECTIONS.runs, keyPart(runId));
    if (!record || !strictlyUntagged(this.tag, record.tag)) return null;
    return this.#runRow(record);
  }

  async getRunAnyTag(runId: string): Promise<RunRow | null> {
    const record = await this.#get(COLLECTIONS.runs, keyPart(runId));
    return record ? this.#runRow(record) : null;
  }

  async runExistsAnyTag(runId: string): Promise<boolean> {
    return (await this.#get(COLLECTIONS.runs, keyPart(runId))) !== null;
  }

  insertRun(run: WorkflowRun): void {
    this.#writer().set(COLLECTIONS.runs, keyPart(run.runId), {
      runId: run.runId,
      tag: this.tag ?? null,
      workflowName: run.workflowName,
      status: run.status,
      createdAt: run.createdAt.getTime(),
      seq: 0,
      seqInBand: 1,
      doc: encode(run),
    });
  }

  async updateRun(run: WorkflowRun): Promise<void> {
    const current = await this.#get(COLLECTIONS.runs, keyPart(run.runId));
    if (!current) return;
    this.#writer().set(COLLECTIONS.runs, keyPart(run.runId), {
      ...stripDoc(current),
      status: run.status,
      doc: encode(run),
    });
  }

  async advanceInBand(runId: string): Promise<void> {
    const current = await this.#get(COLLECTIONS.runs, keyPart(runId));
    if (!current) return;
    this.#writer().set(COLLECTIONS.runs, keyPart(runId), {
      ...current,
      seqInBand: Number(current.seqInBand ?? 1) + 1,
    });
  }

  async topSeq(runId: string): Promise<number> {
    const current = await this.#get(COLLECTIONS.runs, keyPart(runId));
    return Number(current?.seq ?? 0);
  }

  async appendEvent(event: Omit<Event, "eventId"> & { eventId?: string }): Promise<Event> {
    const writer = this.#writer();
    const head = await this.#get(COLLECTIONS.runs, keyPart(event.runId));
    if (!head) throw new Error(`cannot append to run ${event.runId}: it has no run record`);
    const seq = Number(head.seq ?? 0) + 1;
    const stored = { ...event, eventId: slotToEventId(seq) } as Event;
    writer.set(COLLECTIONS.events, joinKey(stored.runId, seq), {
      runId: stored.runId,
      seq,
      eventType: stored.eventType,
      correlationId: (stored as { correlationId?: string }).correlationId ?? null,
      doc: encode(stored),
    });
    writer.set(COLLECTIONS.runs, keyPart(stored.runId), { ...head, seq });
    return stored;
  }

  async getEvent(runId: string, eventId: string): Promise<Event | null> {
    const seq = eventIdToSlot(eventId);
    if (seq === null) return null;
    return this.getEventAt(runId, seq);
  }

  async getEventAt(runId: string, seq: number): Promise<Event | null> {
    const record = await this.#get(COLLECTIONS.events, joinKey(runId, seq));
    return record ? this.#doc<Event>(record) : null;
  }

  async findEvent(runId: string, correlationId: string, eventType: string): Promise<Event | null> {
    for await (const record of this.database.scan(
      COLLECTIONS.events,
      [
        { field: "runId", eq: runId },
        { field: "correlationId", eq: correlationId },
      ],
      [{ field: "seq", direction: "asc" }],
    )) {
      if (record.eventType === eventType) return this.#doc<Event>(record);
    }
    if (this.unit) {
      for (const staged of this.unit.stagedIn(COLLECTIONS.events)) {
        const value = staged.value;
        if (
          value &&
          value.runId === runId &&
          value.correlationId === correlationId &&
          value.eventType === eventType
        ) {
          return decode<Event>(value.doc);
        }
      }
    }
    return null;
  }

  async listEvents(
    runId: string,
    options: {
      cursor?: string;
      limit?: number;
      sortOrder?: "asc" | "desc";
      correlationId?: string;
      maxBytes?: number;
    },
  ): Promise<PaginatedResponse<Event>> {
    const sortOrder = options.sortOrder ?? "asc";
    const limit = Math.max(1, options.limit ?? 20);
    const after = parseEventCursor(options.cursor);
    const fetch = async (from: number | null, take: number) => {
      const where: Array<{ field: string } & Record<string, unknown>> = [
        { field: "runId", eq: runId },
      ];
      if (options.correlationId !== undefined)
        where.push({ field: "correlationId", eq: options.correlationId });
      if (from !== null)
        where.push(sortOrder === "asc" ? { field: "seq", gt: from } : { field: "seq", lt: from });
      const page = await this.database.query(COLLECTIONS.events, where, {
        orderBy: [{ field: "seq", direction: sortOrder }],
        limit: take,
      });
      return page.records;
    };
    const page = (data: Event[], hasMore: boolean) => {
      const last = data.at(-1);
      return { data, cursor: last ? eventCursor(last.eventId) : null, hasMore };
    };
    const { maxBytes } = options;
    if (maxBytes === undefined) {
      const rows = await fetch(after, Math.min(limit + 1, 1000));
      const hasMore = rows.length > limit;
      const kept = hasMore ? rows.slice(0, limit) : rows;
      return page(await Promise.all(kept.map((row) => this.#doc<Event>(row))), hasMore);
    }
    return this.database.snapshot(async () => {
      const data: Event[] = [];
      let bytes = 0;
      let from = after;
      for (;;) {
        const take = Math.min(EVENT_READ_BATCH, limit - data.length + 1);
        const rows = await fetch(from, take);
        for (const row of rows) {
          if (data.length === limit) return page(data, true);
          const text = await this.database.internalize(row, "doc");
          const size = text?.length ?? 0;
          if (data.length > 0 && bytes + size > maxBytes) return page(data, true);
          bytes += size;
          data.push(decode<Event>(text));
          from = Number(row.seq);
        }
        if (rows.length < take) return page(data, false);
      }
    });
  }

  async eventsBetween(runId: string, afterSeq: number, beforeSeq: number): Promise<Event[]> {
    const events: Event[] = [];
    for (let seq = afterSeq + 1; seq < beforeSeq; seq += 1) {
      const event = await this.getEventAt(runId, seq);
      if (event) events.push(event);
    }
    return events;
  }

  async rewriteEvent(event: Event): Promise<void> {
    const seq = eventIdToSlot(event.eventId);
    if (seq === null) return;
    const key = joinKey(event.runId, seq);
    const current = await this.#get(COLLECTIONS.events, key);
    if (!current) return;
    this.#writer().set(COLLECTIONS.events, key, { ...stripDoc(current), doc: encode(event) });
  }

  async getStep(runId: string, stepId: string): Promise<Step | null> {
    const record = await this.#get(COLLECTIONS.steps, joinKey(runId, stepId));
    return record ? this.#doc<Step>(record) : null;
  }

  insertStep(step: Step): void {
    this.#writer().set(COLLECTIONS.steps, joinKey(step.runId, step.stepId), {
      runId: step.runId,
      stepId: step.stepId,
      createdAt: step.createdAt.getTime(),
      doc: encode(step),
    });
  }

  async updateStep(step: Step): Promise<void> {
    const key = joinKey(step.runId, step.stepId);
    const current = await this.#get(COLLECTIONS.steps, key);
    if (!current) return;
    this.#writer().set(COLLECTIONS.steps, key, { ...stripDoc(current), doc: encode(step) });
  }

  async listStepRecords(runId: string): Promise<FeltRecord[]> {
    const records: FeltRecord[] = [];
    for await (const record of this.database.scan(COLLECTIONS.steps, [
      { field: "runId", eq: runId },
    ])) {
      records.push(record);
    }
    return records;
  }

  async stepFrom(record: FeltRecord): Promise<Step> {
    return this.#doc<Step>(record);
  }

  async getWait(runId: string, correlationId: string): Promise<Wait | null> {
    const record = await this.#get(COLLECTIONS.waits, joinKey(runId, correlationId));
    return record ? this.#doc<Wait>(record) : null;
  }

  insertWait(correlationId: string, wait: Wait): void {
    this.#writer().set(COLLECTIONS.waits, joinKey(wait.runId, correlationId), {
      runId: wait.runId,
      waitId: correlationId,
      doc: encode(wait),
    });
  }

  updateWait(correlationId: string, wait: Wait): void {
    this.insertWait(correlationId, wait);
  }

  async deleteWaitsOfRun(runId: string): Promise<void> {
    const writer = this.#writer();
    const ids = new Set<string>();
    for await (const record of this.database.scan(COLLECTIONS.waits, [
      { field: "runId", eq: runId },
    ])) {
      ids.add(joinKey(runId, String(record.waitId)));
    }
    for (const staged of writer.stagedIn(COLLECTIONS.waits)) {
      if (staged.value?.runId === runId) ids.add(staged.id);
    }
    for (const id of ids) {
      await writer.get(COLLECTIONS.waits, id);
      writer.delete(COLLECTIONS.waits, id);
    }
  }

  async getHook(hookId: string): Promise<Hook | null> {
    const record = await this.#get(COLLECTIONS.hooks, keyPart(hookId));
    return record ? this.#doc<Hook>(record) : null;
  }

  async hookIdsOfRun(runId: string): Promise<string[]> {
    const ids = new Set<string>();
    for await (const record of this.database.scan(COLLECTIONS.hooks, [
      { field: "runId", eq: runId },
    ])) {
      ids.add(String(record.hookId));
    }
    if (this.unit) {
      for (const staged of this.unit.stagedIn(COLLECTIONS.hooks)) {
        if (staged.value?.runId === runId) ids.add(String(staged.value.hookId));
      }
    }
    return [...ids];
  }

  upsertHook(hook: Hook): void {
    this.#writer().set(COLLECTIONS.hooks, keyPart(hook.hookId), {
      hookId: hook.hookId,
      runId: hook.runId,
      token: hook.token,
      tag: this.tag ?? null,
      createdAt: hook.createdAt.getTime(),
      doc: encode(hook),
    });
  }

  deleteHook(hookId: string): void {
    this.#writer().delete(COLLECTIONS.hooks, keyPart(hookId));
  }

  async getDisposal(
    hookId: string,
  ): Promise<{ runId: string; forceClaimedBy?: { runId: string; hookId: string } } | null> {
    const record = await this.#get(COLLECTIONS.hookDisposals, keyPart(hookId));
    if (!record) return null;
    return {
      runId: String(record.runId),
      ...(record.forceClaimedBy
        ? { forceClaimedBy: record.forceClaimedBy as { runId: string; hookId: string } }
        : {}),
    };
  }

  async insertDisposal(
    hookId: string,
    runId: string,
    forceClaimedBy?: { runId: string; hookId: string },
  ): Promise<boolean> {
    const writer = this.#writer();
    if (await writer.get(COLLECTIONS.hookDisposals, keyPart(hookId))) return false;
    const record: Record<string, unknown> = { hookId, runId };
    if (forceClaimedBy) record.forceClaimedBy = { ...forceClaimedBy };
    writer.set(COLLECTIONS.hookDisposals, keyPart(hookId), record);
    return true;
  }

  async getTokenOwner(token: string): Promise<TokenOwner | null> {
    const record = await this.#get(COLLECTIONS.hookTokens, keyPart(token));
    if (!record || record.token !== token) return null;
    return {
      hookId: String(record.hookId),
      runId: String(record.runId),
      retentionUntil:
        record.retentionUntil === null || record.retentionUntil === undefined
          ? null
          : Number(record.retentionUntil),
    };
  }

  setTokenOwner(
    token: string,
    hookId: string,
    runId: string,
    retentionUntil: Date | undefined,
  ): void {
    this.#writer().set(COLLECTIONS.hookTokens, keyPart(token), {
      token,
      hookId,
      runId,
      retentionUntil: retentionUntil ? retentionUntil.getTime() : null,
    });
  }

  async releaseToken(token: string, hookId: string): Promise<void> {
    const writer = this.#writer();
    const record = await writer.get(COLLECTIONS.hookTokens, keyPart(token));
    if (record && record.token === token && record.hookId === hookId) {
      writer.delete(COLLECTIONS.hookTokens, keyPart(token));
    }
  }

  async getHookResume(runId: string, resumeId: string): Promise<HookResume | null> {
    const record = await this.#get(COLLECTIONS.hookResumes, joinKey(runId, resumeId));
    if (!record) return null;
    return {
      hookId: String(record.hookId),
      seq: Number(record.seq),
      payloadDigest: (record.payloadDigest as string | null | undefined) ?? null,
    };
  }

  async insertHookResume(runId: string, resumeId: string, resume: HookResume): Promise<boolean> {
    const writer = this.#writer();
    const key = joinKey(runId, resumeId);
    if (await writer.get(COLLECTIONS.hookResumes, key)) return false;
    writer.set(COLLECTIONS.hookResumes, key, { runId, resumeId, ...resume });
    return true;
  }

  async getStartHookRejection(
    runId: string,
  ): Promise<{ token: string; conflictingRunId: string } | null> {
    const record = await this.#get(COLLECTIONS.startHookRejections, keyPart(runId));
    return record
      ? { token: String(record.token), conflictingRunId: String(record.conflictingRunId) }
      : null;
  }

  async insertStartHookRejection(
    runId: string,
    token: string,
    conflictingRunId: string,
  ): Promise<void> {
    const writer = this.#writer();
    if (await writer.get(COLLECTIONS.startHookRejections, keyPart(runId))) return;
    writer.set(COLLECTIONS.startHookRejections, keyPart(runId), {
      runId,
      tag: this.tag ?? null,
      token,
      conflictingRunId,
    });
  }

  async getSnapshot(runId: string): Promise<Uint8Array | null> {
    const record = await this.#get(COLLECTIONS.snapshots, keyPart(runId));
    if (!record) return null;
    const text = await this.database.internalize(record, "envelope");
    return text === null ? null : new Uint8Array(Buffer.from(text, "base64"));
  }

  putSnapshot(runId: string, envelope: Uint8Array): void {
    this.#writer().set(COLLECTIONS.snapshots, keyPart(runId), {
      runId,
      envelope: Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength).toString(
        "base64",
      ),
    });
  }

  async deleteSnapshot(runId: string): Promise<void> {
    const writer = this.#writer();
    if (await writer.get(COLLECTIONS.snapshots, keyPart(runId)))
      writer.delete(COLLECTIONS.snapshots, keyPart(runId));
  }

  visibleTo(rowTag: unknown): boolean {
    return strictlyUntagged(this.tag, rowTag);
  }
}

function stripDoc(record: FeltRecord): FeltRecord {
  const { doc: _doc, docRef: _docRef, ...rest } = record;
  return rest;
}

const EVENT_CURSOR_PREFIX = "key:";

export function eventCursor(eventId: string): string {
  return `${EVENT_CURSOR_PREFIX}${eventId}`;
}

export function parseEventCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  let id = cursor;
  if (id.startsWith(EVENT_CURSOR_PREFIX)) id = id.slice(EVENT_CURSOR_PREFIX.length);
  else if (id.includes("|")) id = id.slice(id.indexOf("|") + 1);
  return eventIdToSlot(id);
}

export function entityCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export function parseEntityCursor(
  cursor: string | undefined,
): { timeMs: number; id: string | null } | null {
  if (!cursor) return null;
  const [time, id] = cursor.split("|");
  const timeMs = new Date(time ?? "").getTime();
  if (!Number.isFinite(timeMs)) return null;
  return { timeMs, id: id || null };
}

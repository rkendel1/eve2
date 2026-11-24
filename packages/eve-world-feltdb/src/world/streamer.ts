/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/streamer.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { EventEmitter } from "node:events";
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from "@workflow/world";
import { COLLECTIONS, joinKey, keyPart, type WorldDatabase } from "./database.js";

const POLL_INTERVAL_MS = 100;
const MAX_CONSECUTIVE_READ_FAILURES = 50;

interface ChunkRow {
  idx: number;
  data: Uint8Array | null;
  eof: boolean;
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
}

export function createStreamer(
  database: WorldDatabase,
  tag?: string,
): Streamer & { clearCache(): void } {
  const signals = new EventEmitter();
  signals.setMaxListeners(0);
  const turns = new Map<string, Promise<unknown>>();

  function inTurn<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = turns.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    turns.set(name, next);
    const forget = () => {
      if (turns.get(name) === next) turns.delete(name);
    };
    next.then(forget, forget);
    return next;
  }

  async function head(name: string): Promise<{ idx: number; eof: boolean } | undefined> {
    const record = await database.read(COLLECTIONS.streams, keyPart(name));
    return record ? { idx: Number(record.idx), eof: record.eof === true } : undefined;
  }

  async function append(
    runId: string,
    name: string,
    chunks: Uint8Array[],
    eof: boolean,
  ): Promise<void> {
    const appended = await database.transact(async (unit) => {
      const current = await unit.get(COLLECTIONS.streams, keyPart(name));
      if (current?.eof === true) return false;
      let idx = Number(current?.idx ?? 0);
      for (const chunk of chunks) {
        idx++;
        unit.set(COLLECTIONS.streamChunks, joinKey(name, idx), {
          name,
          idx,
          runId,
          tag: tag ?? null,
          data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"),
          eof: false,
        });
      }
      if (eof) {
        idx++;
        unit.set(COLLECTIONS.streamChunks, joinKey(name, idx), {
          name,
          idx,
          runId,
          tag: tag ?? null,
          eof: true,
        });
      }
      unit.set(COLLECTIONS.streams, keyPart(name), { name, runId, tag: tag ?? null, idx, eof });
      return true;
    });
    if (appended) signals.emit(name);
  }

  async function rowsAfter(name: string, afterIdx: number, limit?: number): Promise<ChunkRow[]> {
    const rows: ChunkRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const take = limit === undefined ? 1000 : Math.min(1000, limit - rows.length);
      const page = await database.query(
        COLLECTIONS.streamChunks,
        [
          { field: "name", eq: name },
          { field: "idx", gt: afterIdx },
        ],
        { orderBy: [{ field: "idx", direction: "asc" }], limit: take, cursor },
      );
      for (const record of page.records) {
        const text = await database.internalize(record, "data");
        rows.push({
          idx: Number(record.idx),
          data: text === null ? null : new Uint8Array(Buffer.from(text, "base64")),
          eof: record.eof === true,
        });
      }
      if (page.exhausted || !page.nextCursor || (limit !== undefined && rows.length >= limit))
        return rows;
      cursor = page.nextCursor;
    }
  }

  async function info(name: string): Promise<{ count: number; done: boolean }> {
    const last = await head(name);
    if (!last) return { count: 0, done: false };
    return { count: Math.max(0, last.eof ? last.idx - 1 : last.idx), done: last.eof };
  }

  return {
    clearCache() {},
    streams: {
      async write(runIdOrPromise: string | Promise<string>, name: string, chunk) {
        const bytes = toBytes(chunk);
        await inTurn(name, async () => append(await runIdOrPromise, name, [bytes], false));
      },
      async writeMulti(
        runIdOrPromise: string | Promise<string>,
        name: string,
        chunks: (string | Uint8Array)[],
      ) {
        if (chunks.length === 0) return;
        const bytes = chunks.map(toBytes);
        await inTurn(name, async () => append(await runIdOrPromise, name, bytes, false));
      },
      async close(runIdOrPromise: string | Promise<string>, name: string) {
        await inTurn(name, async () => {
          const runId = await runIdOrPromise;
          if ((await info(name)).done) return;
          await append(runId, name, [], true);
        });
      },
      async list(runId: string) {
        const names = new Set<string>();
        for await (const record of database.scan(
          COLLECTIONS.streams,
          [{ field: "runId", eq: runId }],
          [{ field: "name", direction: "asc" }],
        )) {
          names.add(String(record.name));
        }
        return [...names].sort();
      },
      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = options?.limit ?? 100;
        let startIndex = 0;
        if (options?.cursor) {
          try {
            startIndex = JSON.parse(Buffer.from(options.cursor, "base64").toString("utf-8")).i;
          } catch {
            startIndex = 0;
          }
        }
        const rows = await rowsAfter(name, startIndex, limit + 1);
        const data: { index: number; data: Uint8Array }[] = [];
        let done = false;
        let hasMore = false;
        for (const row of rows) {
          if (row.eof) {
            done = true;
            break;
          }
          if (data.length === limit) {
            hasMore = true;
            break;
          }
          data.push({ index: row.idx - 1, data: row.data ?? new Uint8Array() });
        }
        if (!done && !hasMore) done = (await info(name)).done;
        return {
          data,
          cursor: hasMore
            ? Buffer.from(JSON.stringify({ i: startIndex + data.length })).toString("base64")
            : null,
          hasMore,
          done,
        };
      },
      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        const { count, done } = await info(name);
        return { tailIndex: count - 1, done };
      },
      async get(_runId: string, name: string, startIndex = 0) {
        let teardown = () => {};
        let closed = false;
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            let lastIdx =
              typeof startIndex === "number" && startIndex < 0
                ? Math.max(0, (await info(name)).count + startIndex)
                : startIndex;
            let reading = false;
            let again = false;
            let failures = 0;
            let timer: ReturnType<typeof setInterval> | null = null;
            const finish = () => {
              if (closed) return;
              closed = true;
              teardown();
              try {
                controller.close();
              } catch {
                return;
              }
            };
            const drain = async (): Promise<void> => {
              if (closed) return;
              if (reading) {
                again = true;
                return;
              }
              reading = true;
              try {
                for (const row of await rowsAfter(name, lastIdx)) {
                  lastIdx = row.idx;
                  if (row.eof) {
                    finish();
                    return;
                  }
                  if (row.data && row.data.byteLength > 0) controller.enqueue(row.data);
                }
                failures = 0;
                const last = await head(name);
                if (last?.eof && last.idx <= lastIdx) finish();
              } catch (error) {
                failures++;
                if (!closed && failures >= MAX_CONSECUTIVE_READ_FAILURES) {
                  closed = true;
                  teardown();
                  controller.error(error);
                }
              } finally {
                reading = false;
                if (again && !closed) {
                  again = false;
                  void drain();
                }
              }
            };
            const onSignal = () => void drain();
            teardown = () => {
              signals.off(name, onSignal);
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
            };
            signals.on(name, onSignal);
            await drain();
            if (!closed) timer = setInterval(onSignal, POLL_INTERVAL_MS);
          },
          cancel() {
            closed = true;
            teardown();
          },
        });
      },
    },
  };
}

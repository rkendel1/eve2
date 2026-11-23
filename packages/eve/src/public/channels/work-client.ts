import type {
  WorkControl,
  WorkControlName,
  WorkResult,
  WorkStatus,
} from "#internal/work/status.js";
import type { WorkRepository } from "#internal/work/submission.js";

export type {
  WorkAttempt,
  WorkAttemptOutcome,
  WorkControl,
  WorkControlName,
  WorkResult,
  WorkState,
  WorkStatus,
} from "#internal/work/status.js";
export type { WorkRepository } from "#internal/work/submission.js";

/** Headers in any form `new Headers()` accepts. */
export type WorkClientHeaders = ConstructorParameters<typeof Headers>[0];

/** Options for {@link createWorkClient}. */
export interface WorkClientOptions {
  /** The agent's origin, such as `https://agent.example.com`. */
  readonly baseUrl: string | URL;
  /** The work channel's route prefix. @default "/eve/v1/work" */
  readonly route?: string;
  /** Headers sent with every request, such as `authorization`; a function is called per request. */
  readonly headers?: WorkClientHeaders | (() => WorkClientHeaders | Promise<WorkClientHeaders>);
  /** The fetch implementation. @default globalThis.fetch */
  readonly fetch?: typeof fetch;
}

/** The work to submit with {@link WorkClient.submit}. */
export interface WorkSubmissionInput {
  /** What the agent should do. */
  readonly objective: string;
  /** Extra strings the session receives before the objective. */
  readonly context?: readonly string[];
  /** A repository to check out in the work's sandbox before the first model call. */
  readonly repository?: WorkRepository;
}

/** The answer to a submission. `replayed` is `true` when the key already named this work. */
export interface WorkSubmitted {
  readonly sessionId: string;
  readonly deliveryId: string;
  readonly replayed: boolean;
  readonly controls: Readonly<Record<WorkControlName, WorkControl>>;
}

/** The receipt of an accepted steer, interrupt, or stop. Follow its effect on the event stream. */
export interface WorkCommandReceipt {
  readonly sessionId: string;
  readonly deliveryId: string;
}

/**
 * One stored line of the work's session stream. `line` is the raw stored line; resume after it
 * with `cursor`.
 */
export interface WorkEvent {
  readonly position: number;
  readonly cursor: number;
  readonly line: unknown;
}

/** Options for {@link WorkClient.events}. */
export interface WorkEventsOptions {
  /** The next line to read: `0` from the start, or a previous {@link WorkEvent.cursor}. @default 0 */
  readonly cursor?: number;
  /** Stops reading. */
  readonly signal?: AbortSignal;
  /** Most consecutive failed connections before the read throws. @default 5 */
  readonly maxReconnects?: number;
}

/** An error response from the work API, with its HTTP status and `code`. */
export class WorkClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WorkClientError";
    this.status = status;
    this.code = code;
  }
}

/** A typed client for an agent's work channel. It needs only `fetch`, so it runs on Node.js 22. */
export interface WorkClient {
  /** Submits work. The same key and the same work return the same session and run nothing again. */
  submit(
    input: WorkSubmissionInput,
    options: { readonly idempotencyKey: string },
  ): Promise<WorkSubmitted>;
  /** Reads the work's current state. */
  status(sessionId: string): Promise<WorkStatus>;
  /** Reads the latest finished attempt, or `undefined` while the work is queued or running. */
  result(sessionId: string): Promise<WorkResult | undefined>;
  /** Sends a message to the running attempt, or starts the next attempt when none runs. */
  steer(
    sessionId: string,
    message: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<WorkCommandReceipt>;
  /** Cancels the running attempt; `turnId` limits it to the attempt you observed. */
  interrupt(sessionId: string, options?: { readonly turnId?: string }): Promise<WorkCommandReceipt>;
  /** Cancels the running attempt and ends the work. */
  stop(sessionId: string): Promise<WorkCommandReceipt>;
  /**
   * Follows the work's stored event lines from a cursor, reconnecting from the last line read when
   * a lease or connection ends, until the work's session ends or `signal` aborts.
   */
  events(sessionId: string, options?: WorkEventsOptions): AsyncIterable<WorkEvent>;
}

const DEFAULT_ROUTE = "/eve/v1/work";
const RECONNECT_DELAY_MS = 250;

/** Creates a {@link WorkClient} for the work channel at `baseUrl`. */
export function createWorkClient(options: WorkClientOptions): WorkClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const route = options.route ?? DEFAULT_ROUTE;
  const url = (path: string, query?: Record<string, string>) => {
    const target = new URL(`${route}${path}`, options.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
    return target;
  };
  const headers = async (extra: Record<string, string> = {}) => {
    const base =
      typeof options.headers === "function" ? await options.headers() : (options.headers ?? {});
    const merged = new Headers(base);
    for (const [key, value] of Object.entries(extra)) merged.set(key, value);
    return merged;
  };
  const send = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Response> => {
    const extraHeaders: Record<string, string> = { ...extra };
    if (body !== undefined) extraHeaders["content-type"] = "application/json";
    return await fetchImpl(url(path), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: await headers(extraHeaders),
      method,
    });
  };
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) throw await errorOf(response);
    return (await response.json()) as T;
  };
  const path = (sessionId: string, suffix = "") => `/${encodeURIComponent(sessionId)}${suffix}`;

  return {
    async submit(input, submitOptions) {
      return await json<WorkSubmitted>(
        await send("POST", "", input, { "idempotency-key": submitOptions.idempotencyKey }),
      );
    },
    async status(sessionId) {
      return await json<WorkStatus>(await send("GET", path(sessionId)));
    },
    async result(sessionId) {
      const response = await send("GET", path(sessionId, "/result"));
      if (response.status === 409) {
        const error = await errorOf(response);
        if (error.code === "work_not_settled") return undefined;
        throw error;
      }
      return await json<WorkResult>(response);
    },
    async steer(sessionId, message, steerOptions) {
      const key = steerOptions?.idempotencyKey;
      return await json<WorkCommandReceipt>(
        await send(
          "POST",
          path(sessionId, "/messages"),
          { message },
          key === undefined ? {} : { "idempotency-key": key },
        ),
      );
    },
    async interrupt(sessionId, interruptOptions) {
      const body =
        interruptOptions?.turnId === undefined ? {} : { turnId: interruptOptions.turnId };
      return await json<WorkCommandReceipt>(
        await send("POST", path(sessionId, "/interrupt"), body),
      );
    },
    async stop(sessionId) {
      return await json<WorkCommandReceipt>(await send("POST", path(sessionId, "/stop"), {}));
    },
    events(sessionId, eventOptions = {}) {
      return followEvents({
        cursor: eventOptions.cursor ?? 0,
        fetchImpl,
        headers,
        maxReconnects: eventOptions.maxReconnects ?? 5,
        signal: eventOptions.signal,
        url: (cursor) => url(path(sessionId, "/events"), { startIndex: String(cursor) }),
      });
    },
  };
}

async function* followEvents(input: {
  cursor: number;
  readonly fetchImpl: typeof fetch;
  readonly headers: () => Promise<Headers>;
  readonly maxReconnects: number;
  readonly signal: AbortSignal | undefined;
  readonly url: (cursor: number) => URL;
}): AsyncGenerator<WorkEvent> {
  let { cursor } = input;
  let failures = 0;
  while (!isAborted(input.signal)) {
    let ended = false;
    let leaseEnded = false;
    let response: Response;
    try {
      response = await input.fetchImpl(input.url(cursor), {
        headers: await input.headers(),
        signal: input.signal,
      });
    } catch (error) {
      if (isAborted(input.signal)) return;
      failures += 1;
      if (failures > input.maxReconnects) throw error;
      await delay(RECONNECT_DELAY_MS * failures, input.signal);
      continue;
    }
    if (!response.ok) throw await errorOf(response);
    if (response.body === null) throw new WorkClientError(502, "empty_stream", "No stream body.");
    try {
      for await (const record of ndjson(response.body)) {
        const transport = typeof record === "object" && record !== null && "$eve" in record;
        if (!transport) {
          const position = cursor;
          cursor += 1;
          failures = 0;
          yield { cursor, line: record, position };
          continue;
        }
        const kind = (record as { $eve: unknown; next?: unknown }).$eve;
        if (kind === "stream.ended") ended = true;
        if (kind === "stream.lease-ended") leaseEnded = true;
        if (kind === "position") {
          const next = (record as { next?: unknown }).next;
          if (typeof next === "number" && next > cursor) cursor = next;
        }
      }
    } catch (error) {
      if (isAborted(input.signal)) return;
      failures += 1;
      if (failures > input.maxReconnects) throw error;
      await delay(RECONNECT_DELAY_MS * failures, input.signal);
      continue;
    }
    if (ended) return;
    if (!leaseEnded) {
      failures += 1;
      if (failures > input.maxReconnects) {
        throw new WorkClientError(
          502,
          "stream_disconnected",
          "The event stream kept disconnecting.",
        );
      }
      await delay(RECONNECT_DELAY_MS * failures, input.signal);
    }
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (text.length > 0) yield JSON.parse(text) as unknown;
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim().length > 0) yield JSON.parse(buffer) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function errorOf(response: Response): Promise<WorkClientError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code : `http_${response.status}`;
  const message =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : `The work API answered ${response.status}.`;
  return new WorkClientError(response.status, code, message);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

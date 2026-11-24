/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/queue.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { setTimeout } from "node:timers/promises";
import {
  createAppRouteUrl,
  createLogLimiter,
  createWorkflowUrl,
  debugLog,
  getQueueAuthKey,
  isQueueAuthRefusal,
  QUEUE_AUTH_HEADER,
} from "@workflow/utils";
import {
  isNodeHttpEnabled,
  isSingleOrchestratorMessage,
  MessageId,
  messageRunSpecVersion,
  orchestratorRunIdOf,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  QueuePrefix,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  singleOrchestratorRunIdOf,
  ValidQueueName,
  WORKFLOW_FLOW_ROUTE,
} from "@workflow/world";
import {
  createNodeHttpAgents,
  destroyNodeHttpAgents,
  nodeHttpFetch,
} from "@workflow/world/node-http.js";
import { Sema } from "async-sema";
import { monotonicFactory } from "ulid";
import { Agent } from "undici";
import { z } from "zod/v4";
import type { Config } from "./config.js";
import { resolveBaseUrl, resolveDirectBaseUrl } from "./config.js";
import { jsonReplacer, jsonReviver } from "./codec.js";
import { getPackageInfo } from "./package-info.js";
import type { QueueRecords, StoredMessage } from "./queue-records.js";
import type { QueueAuthKey } from "./queue-auth-key.js";
interface Transport<T> {
  readonly contentType: string;
  serialize(value: T): Buffer;
  deserialize(stream: ReadableStream<Uint8Array>): Promise<T>;
}
class TypedJsonTransport implements Transport<unknown> {
  readonly contentType = "application/json";
  serialize(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value, jsonReplacer));
  }
  deserializeText(text: string): unknown {
    return JSON.parse(text, jsonReviver);
  }
  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString();
    return JSON.parse(text, jsonReviver);
  }
}
const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? "0", 10) || Infinity;
export const MAX_SAFE_TIMEOUT_MS = 2147483647;
const CLOSE_FIRST_ATTEMPT_WAIT_MS = 1000;
const CLOSE_RUN_MESSAGE_WAIT_MS = 10000;
const CLOSE_POLL_MS = 50;
interface FirstAttempt {
  done: Promise<void>;
  runId?: string;
  seqAtSend?: number;
}
export const MAX_LOCAL_SAFETY_LIMIT = 256;
export const MAX_QUEUE_AUTH_REFUSALS = 5;
export const MAX_UNCOUNTED_KEY_ROTATIONS = 16;
const LINEAR_RETRY_DELIVERIES = 32;
const LINEAR_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;
export function localRetryDelayMs(failedDeliveries: number): number {
  if (failedDeliveries <= LINEAR_RETRY_DELIVERIES) return LINEAR_RETRY_DELAY_MS;
  return Math.min(
    MAX_RETRY_DELAY_MS,
    LINEAR_RETRY_DELAY_MS * 2 ** (failedDeliveries - LINEAR_RETRY_DELIVERIES),
  );
}
const DEFAULT_CONCURRENCY_LIMIT = 1000;
const WORKFLOW_LOCAL_QUEUE_CONCURRENCY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? "0", 10) || DEFAULT_CONCURRENCY_LIMIT;
export const DEFAULT_HEADERS_TIMEOUT_MS = 0;
export const DEFAULT_BODY_TIMEOUT_MS = 0;
function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
export function getQueueAgentOptions() {
  return {
    bodyTimeout: envTimeoutMs("WORKFLOW_LOCAL_BODY_TIMEOUT_MS", DEFAULT_BODY_TIMEOUT_MS),
    connections: 1000,
    headersTimeout: envTimeoutMs("WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS),
    keepAliveTimeout: 30000,
  } as const;
}
export type DirectHandler = (req: Request) => Promise<Response>;
export type LocalQueue = Queue & {
  resumeStored(): Promise<number>;
  close(): Promise<void>;
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  registerRoute(prefix: QueuePrefix, path: string): void;
};
const QUEUE_AUTH_REFUSAL_HINT =
  "A queue delivery is accepted only with the app's key, from the file queue-auth-key in " +
  "the app's data directory. Run the sender on the same data directory as the app " +
  "(WORKFLOW_LOCAL_DATA_DIR) and on the same release. On a trusted network, set " +
  "WORKFLOW_QUEUE_AUTH=off on the app to accept other senders (refused while dynamic " +
  "workflows are enabled).";
const DETACHED_ARRAYBUFFER_ERROR =
  "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer";
const PROXY_HANDLER_DOCS_URL =
  "https://workflow-sdk.dev/docs/getting-started/next#configure-proxy-handler";
function isDetachedArrayBufferQueueError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (
      "message" in current &&
      typeof current.message === "string" &&
      current.message.includes(DETACHED_ARRAYBUFFER_ERROR)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
export function createRunGate() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(runId: string): Promise<() => void> {
      const previous = tails.get(runId) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      tails.set(runId, tail);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (tails.get(runId) === tail) tails.delete(runId);
      };
    },
    size(): number {
      return tails.size;
    },
  };
}
export const MAX_LOCAL_COALESCED_RERUNS = 32;
export const INVOCATION_STARTED_AT_HEADER = "x-workflow-local-invocation-started-at";
export interface CoalescedResume {
  hookResumeTiming: unknown;
  traceCarrier?: unknown;
}
export interface OrchestratorLease {
  release(): void;
  takeWaiting(): {
    count: number;
    resume?: CoalescedResume;
  };
}
export function createOrchestratorGate() {
  interface Waiter {
    coalescible: boolean;
    resume?: CoalescedResume;
    grant: (lease: OrchestratorLease | undefined) => void;
  }
  const runs = new Map<string, Waiter[]>();
  const lease = (key: string): OrchestratorLease => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const waiters = runs.get(key);
        const next = waiters?.shift();
        if (!next) {
          runs.delete(key);
          return;
        }
        next.grant(lease(key));
      },
      takeWaiting() {
        const waiters = runs.get(key);
        if (released || !waiters) return { count: 0 };
        let count = 0;
        let resume: CoalescedResume | undefined;
        const kept: Waiter[] = [];
        for (const waiter of waiters) {
          if (!waiter.coalescible) {
            kept.push(waiter);
            continue;
          }
          count++;
          resume ??= waiter.resume;
          waiter.grant(undefined);
        }
        runs.set(key, kept);
        return { count, ...(resume && { resume }) };
      },
    };
  };
  return {
    acquire(
      key: string,
      options: {
        coalescible?: boolean;
        resume?: CoalescedResume;
      } = {},
    ): Promise<OrchestratorLease | undefined> {
      const waiters = runs.get(key);
      if (!waiters) {
        runs.set(key, []);
        return Promise.resolve(lease(key));
      }
      return new Promise((grant) => {
        const waiter: Waiter = {
          coalescible: options.coalescible === true,
          ...(options.resume && { resume: options.resume }),
          grant,
        };
        waiters.push(waiter);
      });
    },
    size(): number {
      return runs.size;
    },
  };
}
function isAcknowledgement(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !("timeoutSeconds" in parsed) &&
      !("result" in parsed)
    );
  } catch {
    return false;
  }
}
function isHandoff(text: string): boolean {
  try {
    return Number(JSON.parse(text).timeoutSeconds) === 0;
  } catch {
    return false;
  }
}
function isCoalescible(message: Record<string, unknown>): boolean {
  return !(
    "runInput" in message ||
    "hookInput" in message ||
    (Array.isArray(message.completeWaits) && message.completeWaits.length > 0) ||
    message.recovery === true ||
    message.invoke
  );
}
function resumeOf(message: Record<string, unknown>): CoalescedResume | undefined {
  if (message.hookResumeTiming === undefined) return undefined;
  return {
    hookResumeTiming: message.hookResumeTiming,
    ...(message.traceCarrier !== undefined && {
      traceCarrier: message.traceCarrier,
    }),
  };
}
const inMemoryQueueAuthKey: QueueAuthKey = {
  current: async () => getQueueAuthKey(),
  reload: async () => getQueueAuthKey(),
  restore: async () => {},
  written: async () => {},
};
export function createQueue(
  config: Partial<Config>,
  options: {
    queueAuthKey?: QueueAuthKey;
    runSpecVersion?: (runId: string) => Promise<number | undefined>;
    records: QueueRecords;
    runSeq: (runId: string) => Promise<number | undefined>;
  },
): LocalQueue {
  const queueAuthKey = options.queueAuthKey ?? inMemoryQueueAuthKey;
  const stampFromRun = async (message: unknown): Promise<unknown> => {
    if (!options.runSpecVersion) return message;
    if (messageRunSpecVersion(message) !== undefined) return message;
    const runId = orchestratorRunIdOf(message);
    if (runId === undefined) return message;
    const specVersion = await options.runSpecVersion(runId);
    return specVersion !== undefined && specVersion >= SPEC_VERSION_SINGLE_ORCHESTRATOR
      ? { ...(message as Record<string, unknown>), runSpecVersion: specVersion }
      : message;
  };
  const agentOptions = getQueueAgentOptions();
  const nodeHttpAgents = isNodeHttpEnabled()
    ? createNodeHttpAgents({
        maxSockets: agentOptions.connections,
        keepAliveMs: agentOptions.keepAliveTimeout,
      })
    : undefined;
  const httpAgent = nodeHttpAgents ? undefined : new Agent(agentOptions);
  const transport = new TypedJsonTransport();
  const generateId = monotonicFactory();
  const semaphore = new Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);
  const runGate = createOrchestratorGate();
  const handlerRunGate = createRunGate();
  const logAuthRefusal = createLogLimiter();
  const closeController = new AbortController();
  const closeSignal = closeController.signal;
  const firstAttempts = new Set<FirstAttempt>();
  let closing: Promise<void> | undefined;
  const runSeq = async (runId: string): Promise<number | undefined> => {
    try {
      return await options.runSeq(runId);
    } catch {
      return undefined;
    }
  };
  const records = options.records;
  const inflightMessages = new Map<string, MessageId>();
  const directHandlers = new Map<string, DirectHandler>();
  const routes = new Map<string, string>();
  const deliveryUrl = (baseUrl: string, prefix: string) => {
    const route = routes.get(prefix);
    return route ? createAppRouteUrl(baseUrl, route) : createWorkflowUrl(baseUrl, { type: "flow" });
  };
  const rerunBody = (message: unknown, resume: CoalescedResume | undefined): Uint8Array => {
    const { hookResumeTiming: _consumed, ...rest } = message as Record<string, unknown>;
    return transport.serialize(
      resume
        ? {
            ...rest,
            hookResumeTiming: resume.hookResumeTiming,
            ...(resume.traceCarrier !== undefined && {
              traceCarrier: resume.traceCarrier,
            }),
          }
        : rest,
    );
  };
  const send = async (
    queueName: Parameters<Queue["queue"]>[0],
    sentMessage: unknown,
    opts: Parameters<Queue["queue"]>[2],
    restored?: StoredMessage,
  ): Promise<{
    messageId: MessageId;
  }> => {
    const cleanup = [] as (() => void)[];
    const message = restored ? sentMessage : await stampFromRun(sentMessage);
    if (!restored && opts?.idempotencyKey) {
      const existing = inflightMessages.get(opts.idempotencyKey);
      if (existing) {
        return { messageId: existing };
      }
    }
    const body = transport.serialize(message);
    const { prefix } = parseQueueName(queueName);
    const callerHeaders = Object.fromEntries(
      Object.entries(opts?.headers ?? {}).filter(([name]) => {
        const lower = name.toLowerCase();
        return lower !== QUEUE_AUTH_HEADER && lower !== INVOCATION_STARTED_AT_HEADER;
      }),
    );
    const messageId = MessageId.parse(restored?.messageId ?? `msg_${generateId()}`);
    const createdAt = restored?.createdAt ?? new Date().toISOString();
    const msg = message as Record<string, unknown>;
    const runId = (msg.runId ?? undefined) as string | undefined;
    const stepId = (msg.stepId ?? undefined) as string | undefined;
    const orchestratorRunKey = (() => {
      const id = singleOrchestratorRunIdOf(message);
      return id === undefined ? undefined : `${prefix}${id}`;
    })();
    const handsOff = isSingleOrchestratorMessage(message);
    const fields = message as Record<string, unknown>;
    const coalescible = orchestratorRunKey !== undefined && isCoalescible(fields);
    const rerunsCoalesced = orchestratorRunKey !== undefined && fields.invoke !== true;
    if (!restored) {
      const stored = await records.create({
        messageId,
        queueName,
        body: Buffer.from(body).toString("utf8"),
        headers: callerHeaders,
        idempotencyKey: opts?.idempotencyKey ?? null,
        createdAt,
        deliveryCount: 0,
        visibleAt:
          Date.now() + (opts?.delaySeconds && opts.delaySeconds > 0 ? opts.delaySeconds * 1000 : 0),
        runId: runId ?? null,
      });
      if (!stored.created) return { messageId: MessageId.parse(stored.messageId) };
    }
    let finished = false;
    const finish = () => {
      finished = true;
    };
    if (opts?.idempotencyKey) {
      const key = opts.idempotencyKey;
      inflightMessages.set(key, messageId);
      cleanup.push(() => {
        inflightMessages.delete(key);
      });
    }
    let firstAttemptDone = () => {};
    const delayMs = restored
      ? Math.max(0, restored.visibleAt - Date.now())
      : opts?.delaySeconds && opts.delaySeconds > 0
        ? opts.delaySeconds * 1000
        : 0;
    if (!restored && delayMs === 0) {
      let resolve = () => {};
      const attempt: FirstAttempt = {
        done: new Promise<void>((done) => {
          resolve = done;
        }),
        runId,
        seqAtSend: runId === undefined ? undefined : await runSeq(runId),
      };
      firstAttempts.add(attempt);
      firstAttemptDone = () => {
        firstAttempts.delete(attempt);
        resolve();
      };
    }
    (async () => {
      if (delayMs > 0) {
        await setTimeout(Math.min(delayMs, MAX_SAFE_TIMEOUT_MS), undefined, {
          signal: closeSignal,
        });
      }
      const acquireDelivery = async (): Promise<
        | {
            release: () => void;
            lease?: OrchestratorLease;
          }
        | "coalesced"
      > => {
        let lease: OrchestratorLease | undefined;
        if (orchestratorRunKey) {
          lease = await runGate.acquire(orchestratorRunKey, {
            coalescible,
            resume: resumeOf(fields),
          });
          if (!lease) return "coalesced";
        }
        if (!semaphore.tryAcquire()) {
          debugLog(
            `[world-feltdb]: concurrency limit (${WORKFLOW_LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`,
          );
          await semaphore.acquire();
        }
        return {
          release: () => {
            semaphore.release();
            lease?.release();
          },
          ...(lease && { lease }),
        };
      };
      const MAX_LOCAL_HANDOFFS = 10000;
      let delivery = restored?.deliveryCount ?? 0;
      let handoffs = 0;
      let failedDeliveries = 0;
      let authRefusals = 0;
      let keyRotations = 0;
      let reruns = 0;
      let rerunsThisHold = 0;
      let deliveryBody: Uint8Array = body;
      let holdStartedAt = 0;
      let releaseDelivery: (() => void) | undefined;
      let lease: OrchestratorLease | undefined;
      const endDelivery = () => {
        releaseDelivery?.();
        releaseDelivery = undefined;
        lease = undefined;
      };
      try {
        for (let loop = 0; loop - handoffs - reruns < MAX_LOCAL_SAFETY_LIMIT; loop++) {
          if (!releaseDelivery) {
            const acquired = await acquireDelivery();
            if (acquired === "coalesced") {
              finish();
              return;
            }
            releaseDelivery = acquired.release;
            lease = acquired.lease;
            rerunsThisHold = 0;
            holdStartedAt = Date.now();
          }
          if (closeSignal.aborted) return;
          const sentKey = await queueAuthKey.current();
          const headers: Record<string, string> = {
            ...callerHeaders,
            "content-type": "application/json",
            ...(sentKey !== undefined && { [QUEUE_AUTH_HEADER]: sentKey }),
            "x-vqs-queue-name": queueName,
            "x-vqs-message-id": messageId,
            "x-vqs-message-attempt": String(delivery + 1 - handoffs - reruns),
            "x-vqs-message-delivery-count": String(delivery + 1),
            "x-vqs-message-created-at": createdAt,
            ...(orchestratorRunKey && {
              [INVOCATION_STARTED_AT_HEADER]: String(holdStartedAt),
            }),
          };
          const directHandler = directHandlers.get(prefix);
          let response: Response;
          let text: string;
          await records.attempt(messageId, delivery + 1);
          try {
            if (directHandler) {
              const req = new Request(deliveryUrl(resolveDirectBaseUrl(config), prefix), {
                method: "POST",
                headers,
                body: deliveryBody,
              });
              response = await directHandler(req);
            } else {
              const baseUrl = await resolveBaseUrl(config);
              const url = deliveryUrl(baseUrl, prefix);
              response = nodeHttpAgents
                ? await nodeHttpFetch(url, {
                    method: "POST",
                    headers: new Headers(headers),
                    body: deliveryBody,
                    agents: nodeHttpAgents,
                    signal: closeSignal,
                    headersTimeoutMs: agentOptions.headersTimeout,
                    bodyTimeoutMs: agentOptions.bodyTimeout,
                  })
                : await fetch(url, {
                    method: "POST",
                    duplex: "half",
                    dispatcher: httpAgent,
                    headers,
                    body: deliveryBody,
                    signal: closeSignal,
                  } as any);
            }
            firstAttemptDone();
            delivery++;
            text = await response.text();
          } catch (err) {
            firstAttemptDone();
            endDelivery();
            const name = (
              err as
                | {
                    name?: string;
                  }
                | undefined
            )?.name;
            if (closeSignal.aborted || name === "AbortError" || name === "ResponseAborted") {
              return;
            }
            if (isDetachedArrayBufferQueueError(err)) throw err;
            console.error(
              `[world-feltdb] Queue delivery failed at the transport (loop ${loop + 1}), retrying`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                error: String(err),
              },
            );
            await setTimeout(5000, undefined, { signal: closeSignal });
            continue;
          }
          if (
            response.ok &&
            lease &&
            rerunsCoalesced &&
            rerunsThisHold < MAX_LOCAL_COALESCED_RERUNS &&
            isAcknowledgement(text)
          ) {
            const taken = lease.takeWaiting();
            if (taken.count > 0) {
              reruns++;
              rerunsThisHold++;
              deliveryBody = rerunBody(message, taken.resume);
              continue;
            }
          }
          if (response.ok && handsOff && handoffs < MAX_LOCAL_HANDOFFS && isHandoff(text)) {
            handoffs++;
            if (lease) {
              holdStartedAt = Date.now();
              rerunsThisHold = 0;
              if (rerunsCoalesced) {
                const taken = lease.takeWaiting();
                if (taken.resume) {
                  deliveryBody = rerunBody(message, taken.resume);
                }
              }
            } else {
              endDelivery();
            }
            continue;
          }
          endDelivery();
          if (response.ok) {
            try {
              const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
              if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
                if (timeoutSeconds > 0) {
                  const timeoutMs = Math.min(timeoutSeconds * 1000, MAX_SAFE_TIMEOUT_MS);
                  await records.schedule(messageId, Date.now() + timeoutMs);
                  await setTimeout(timeoutMs, undefined, {
                    signal: closeSignal,
                  });
                } else if (handsOff && handoffs < MAX_LOCAL_HANDOFFS) {
                  handoffs++;
                }
                continue;
              }
            } catch {}
            finish();
            return;
          }
          if (isQueueAuthRefusal(response)) {
            delivery--;
            const reloadedKey = await queueAuthKey.reload();
            if (
              reloadedKey !== undefined &&
              reloadedKey !== sentKey &&
              keyRotations < MAX_UNCOUNTED_KEY_ROTATIONS
            ) {
              keyRotations++;
              debugLog(
                "[world-feltdb]: delivery refused as unauthenticated; the queue auth key changed, retrying with it",
              );
              continue;
            }
            authRefusals++;
            if (authRefusals < MAX_QUEUE_AUTH_REFUSALS) {
              debugLog(
                `[world-feltdb]: delivery refused as unauthenticated (${authRefusals}/${MAX_QUEUE_AUTH_REFUSALS}), retrying`,
              );
              await setTimeout(localRetryDelayMs(authRefusals), undefined, {
                signal: closeSignal,
              });
              continue;
            }
            logAuthRefusal((refusedSinceLastLog) => {
              console.error(
                `[world-feltdb] Queue delivery refused by the app as unauthenticated ${MAX_QUEUE_AUTH_REFUSALS} times; giving up the message`,
                {
                  queueName,
                  messageId,
                  ...(runId && { runId }),
                  ...(stepId && { stepId }),
                  refusedSinceLastLog,
                  hint: QUEUE_AUTH_REFUSAL_HINT,
                },
              );
            });
            finish();
            return;
          }
          console.error(
            `[world-feltdb] Queue message failed (attempt ${delivery}, HTTP ${response.status})`,
            {
              queueName,
              messageId,
              ...(runId && { runId }),
              ...(stepId && { stepId }),
              handlerError: text,
              ...(response.status === 401 && {
                hint:
                  "A 401 without the Workflow runtime’s refusal marker, so not a queue auth " +
                  "refusal (perhaps a proxy or auth layer in front of the app). Retrying.",
              }),
              ...(!directHandler &&
                !routes.has(prefix) &&
                (response.status === 400 || response.status === 404) && {
                  hint:
                    `No route or handler is registered for queue prefix "${prefix}", ` +
                    `so its messages go to the Workflow SDK's flow route (${WORKFLOW_FLOW_ROUTE}). ` +
                    `A queue consumer of its own registers one with world.registerRoute(prefix, path) or world.registerHandler(prefix, handler).`,
                }),
            },
          );
          failedDeliveries++;
          await setTimeout(localRetryDelayMs(failedDeliveries), undefined, {
            signal: closeSignal,
          });
        }
        finish();
        console.error(
          `[world-feltdb] Queue message exhausted safety limit (${MAX_LOCAL_SAFETY_LIMIT} attempts)`,
          {
            queueName,
            messageId,
            ...(runId && { runId }),
            ...(stepId && { stepId }),
          },
        );
      } finally {
        firstAttemptDone();
        endDelivery();
      }
    })()
      .catch((err) => {
        const isAbortError = err?.name === "AbortError" || err?.name === "ResponseAborted";
        if (!isAbortError) {
          if (isDetachedArrayBufferQueueError(err)) {
            console.error(
              `[local world] Queue operation failed: detected "${DETACHED_ARRAYBUFFER_ERROR}". ` +
                "This usually means a Next.js proxy/middleware consumed Workflow's internal " +
                "request before the executor could read it. Exclude `/.well-known/workflow/*` " +
                `from your matcher. See ${PROXY_HANDLER_DOCS_URL}`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                originalError: err,
              },
            );
          } else {
            console.error("[local world] Queue operation failed:", err);
          }
        }
      })
      .finally(async () => {
        if (finished) {
          await records.remove(messageId).catch((error) => {
            console.error("[world-feltdb] could not remove a finished queue message", {
              messageId,
              error: String(error),
            });
          });
        }
        for (const fn of cleanup) {
          fn();
        }
      });
    return { messageId };
  };
  const queue: Queue["queue"] = (queueName, sentMessage, opts) =>
    send(queueName, sentMessage, opts);
  const resumeStored = async (): Promise<number> => {
    let resumed = 0;
    for await (const stored of records.all()) {
      const message = transport.deserializeText(stored.body);
      const resumeOptions: NonNullable<Parameters<Queue["queue"]>[2]> = { headers: stored.headers };
      if (stored.idempotencyKey) resumeOptions.idempotencyKey = stored.idempotencyKey;
      await send(stored.queueName as Parameters<Queue["queue"]>[0], message, resumeOptions, stored);
      resumed++;
    }
    return resumed;
  };
  const HeaderParser = z.object({
    "x-vqs-queue-name": ValidQueueName,
    "x-vqs-message-id": MessageId,
    "x-vqs-message-attempt": z.coerce.number(),
    "x-vqs-message-delivery-count": z.coerce.number().int().positive().optional(),
    "x-vqs-message-created-at": z.iso.datetime().optional(),
    [INVOCATION_STARTED_AT_HEADER]: z.coerce.number().int().positive().optional(),
  });
  const createQueueHandler: Queue["createQueueHandler"] = (prefix, handler) => {
    return async (req) => {
      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));
      if (!headers.success || !req.body) {
        return Response.json(
          {
            error: !req.body ? "Missing request body" : "Missing required headers",
          },
          { status: 400 },
        );
      }
      const queueName = headers.data["x-vqs-queue-name"];
      const messageId = headers.data["x-vqs-message-id"];
      const attempt = headers.data["x-vqs-message-attempt"];
      const deliveryCountHeader = headers.data["x-vqs-message-delivery-count"];
      const createdAtHeader = headers.data["x-vqs-message-created-at"];
      if (!queueName.startsWith(prefix)) {
        return Response.json(
          {
            error: "Unhandled queue",
            detail: `This route handles queue prefix "${prefix}", not "${queueName}".`,
          },
          { status: 400 },
        );
      }
      const body = await stampFromRun(await new TypedJsonTransport().deserialize(req.body));
      const invocationStartedAt = headers.data[INVOCATION_STARTED_AT_HEADER];
      const orchestratorRunId = singleOrchestratorRunIdOf(body);
      const releaseRun =
        orchestratorRunId === undefined
          ? undefined
          : await handlerRunGate.acquire(`${prefix}${orchestratorRunId}`);
      try {
        const result = await handler(body, {
          attempt,
          deliveryCount: deliveryCountHeader ?? attempt,
          ...(createdAtHeader ? { createdAt: new Date(createdAtHeader) } : {}),
          ...(invocationStartedAt !== undefined && { invocationStartedAt }),
          queueName,
          messageId,
        });
        if (typeof body === "object" && body !== null && "invoke" in body && body.invoke === true) {
          return Response.json({ result });
        }
        let timeoutSeconds: number | null = null;
        if (
          typeof result === "object" &&
          result !== null &&
          "timeoutSeconds" in result &&
          typeof result.timeoutSeconds === "number"
        ) {
          timeoutSeconds = Math.min(result.timeoutSeconds, LOCAL_QUEUE_MAX_VISIBILITY);
        }
        if (timeoutSeconds != null) {
          return Response.json({ timeoutSeconds });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      } finally {
        releaseRun?.();
      }
    };
  };
  const getDeploymentId: Queue["getDeploymentId"] = async () => {
    const packageInfo = await getPackageInfo();
    return `dpl_feltdb@${packageInfo.version}`;
  };
  return {
    queueAuthMode: "loopback",
    queue,
    resumeStored,
    createQueueHandler,
    getDeploymentId,
    registerHandler(prefix: QueuePrefix, handler: DirectHandler) {
      directHandlers.set(prefix, handler);
    },
    registerRoute(prefix: QueuePrefix, path: string) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    close() {
      closing ??= (async () => {
        const started = Date.now();
        const unreached = async () => {
          const open: FirstAttempt[] = [];
          for (const attempt of firstAttempts) {
            const elapsed = Date.now() - started;
            if (attempt.seqAtSend === undefined || attempt.runId === undefined) {
              if (elapsed < CLOSE_FIRST_ATTEMPT_WAIT_MS) open.push(attempt);
              continue;
            }
            if (elapsed >= CLOSE_RUN_MESSAGE_WAIT_MS) continue;
            const seq = await runSeq(attempt.runId);
            if (seq === undefined || seq <= attempt.seqAtSend) open.push(attempt);
          }
          return open;
        };
        for (let open = await unreached(); open.length > 0; open = await unreached()) {
          let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled(open.map((attempt) => attempt.done)),
            new Promise<void>((resolve) => {
              timer = globalThis.setTimeout(resolve, CLOSE_POLL_MS);
              timer.unref?.();
            }),
          ]);
          globalThis.clearTimeout(timer);
        }
        closeController.abort();
        if (nodeHttpAgents) destroyNodeHttpAgents(nodeHttpAgents);
        await httpAgent?.close();
      })();
      return closing;
    },
  };
}

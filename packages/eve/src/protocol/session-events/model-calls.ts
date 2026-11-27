import type { Fact, Progress } from "./facts.js";
import type { Usage, UsageCount } from "./envelope.js";
import type { ModelComposedData, ModelOutcome, ModelOwner } from "./families/model.js";

/** A provider-reported token count: `null` when the provider did not report it. */
export type ReportedCount = number | null;

/** What the provider reported for one model call. Never estimated. */
export interface ModelCallUsage {
  readonly inputTokens: ReportedCount;
  readonly outputTokens: ReportedCount;
  readonly cacheReadTokens: ReportedCount;
  readonly cacheWriteTokens: ReportedCount;
  /** `null` when the provider reported no cost. */
  readonly costUsd: number | null;
}

/** Prompt caching for one model call, keeping what was asked for apart from what was observed. */
export interface ModelCallCache {
  /**
   * Whether the request asked for caching: explicit cache markers or the gateway's `auto` caching.
   * `false` does not rule out a provider's own automatic caching. `undefined` without a composition.
   */
  readonly requested: boolean | undefined;
  /** Whether the provider reported cache reads. `undefined` when no usage was recorded. */
  readonly reported: boolean | undefined;
  /**
   * `cacheReadTokens / inputTokens`, when both were reported, input is above 0, and the counts are
   * consistent with input that includes cached tokens (cache reads and writes do not exceed it).
   */
  readonly readShare?: number;
}

/** One attempt of a model run: what it was sent (estimated) and what the provider reported. */
export interface ModelCall {
  readonly runId: string;
  readonly attempt: number;
  readonly owner?: ModelOwner;
  /** The model the run's participants chose, from `model.started`. */
  readonly modelId: string;
  /** `retried` when another attempt followed; `open` while the run has not settled. */
  readonly outcome: ModelOutcome | "retried" | "open";
  /** How many times the request was sent within this attempt. */
  readonly sends: number;
  /** The last send's composition; absent for calls eve did not measure, such as compaction summaries. */
  readonly composition?: ModelComposedData;
  /** Absent when no usage was recorded for the attempt. */
  readonly usage?: ModelCallUsage;
  readonly cache: ModelCallCache;
}

/**
 * Join a session's `model.started`, `model.composed`, `model.retried`, `model.settled` and
 * `usage.recorded` facts, in stream order, into one record per model call attempt.
 */
export function modelCalls(events: Iterable<Fact | Progress>): readonly ModelCall[] {
  const owners = new Map<string, ModelOwner>();
  const current = new Map<string, Draft>();
  const calls: Draft[] = [];
  for (const event of events) {
    switch (event.type) {
      case "model.requested":
        owners.set(event.data.runId, event.data.owner);
        break;
      case "model.started": {
        const previous = current.get(event.data.runId);
        if (previous !== undefined && previous.outcome === "open") previous.outcome = "retried";
        const draft: Draft = {
          attempt: event.data.attempt,
          modelId: event.data.modelId,
          outcome: "open",
          runId: event.data.runId,
          sends: 0,
        };
        current.set(event.data.runId, draft);
        calls.push(draft);
        break;
      }
      case "model.composed": {
        const draft = current.get(event.data.runId);
        if (draft === undefined || draft.attempt !== event.data.attempt) break;
        draft.sends++;
        draft.composition = event.data;
        break;
      }
      case "model.retried": {
        const draft = current.get(event.data.runId);
        if (draft !== undefined && draft.attempt === event.data.attempt) draft.outcome = "retried";
        break;
      }
      case "model.settled": {
        const draft = current.get(event.data.runId);
        if (draft !== undefined && draft.outcome === "open") draft.outcome = event.data.outcome;
        break;
      }
      case "usage.recorded": {
        const owner = event.data.owner;
        const draft =
          owner !== undefined && "runId" in owner ? current.get(owner.runId) : undefined;
        if (draft !== undefined) draft.usage = addUsage(draft.usage, event.data.usage);
        break;
      }
      default:
        break;
    }
  }
  return calls.map((draft) => finish(draft, owners.get(draft.runId)));
}

interface Draft {
  readonly runId: string;
  readonly attempt: number;
  readonly modelId: string;
  outcome: ModelCall["outcome"];
  sends: number;
  composition?: ModelComposedData;
  usage?: Usage;
}

function finish(draft: Draft, owner: ModelOwner | undefined): ModelCall {
  const usage = draft.usage === undefined ? undefined : reported(draft.usage);
  const { composition } = draft;
  return {
    attempt: draft.attempt,
    cache: {
      reported: usage === undefined ? undefined : usage.cacheReadTokens !== null,
      requested:
        composition === undefined
          ? undefined
          : composition.cache.markers > 0 || composition.cache.gateway === "auto",
      ...(usage !== undefined && readShare(usage)),
    },
    modelId: draft.modelId,
    outcome: draft.outcome,
    runId: draft.runId,
    sends: draft.sends,
    ...(composition !== undefined && { composition }),
    ...(owner !== undefined && { owner }),
    ...(usage !== undefined && { usage }),
  };
}

function reported(usage: Usage): ModelCallUsage {
  const unreported = new Set<UsageCount>(usage.unreported);
  const count = (name: UsageCount): ReportedCount => (unreported.has(name) ? null : usage[name]);
  return {
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: usage.costUsd ?? null,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
  };
}

function readShare(usage: ModelCallUsage): { readonly readShare?: number } {
  const { cacheReadTokens: read, cacheWriteTokens: write, inputTokens: input } = usage;
  if (read === null || input === null || input === 0) return {};
  if (read + (write ?? 0) > input) return {};
  return { readShare: read / input };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return b;
  const unreported = [...new Set([...(a.unreported ?? []), ...(b.unreported ?? [])])];
  return {
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...((a.costUsd !== undefined || b.costUsd !== undefined) && {
      costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    }),
    ...(unreported.length > 0 && { unreported }),
  };
}

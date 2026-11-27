import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Envelope, ErrorInfo } from "../envelope.js";

/** What a model run belongs to: a turn, or a context change's summary. */
export type ModelOwner = { readonly turnId: string } | { readonly changeId: string };

/** The payload of `model.requested`: a model run is introduced for its owner. */
export interface ModelRequestedData {
  readonly runId: string;
  readonly owner: ModelOwner;
}

/**
 * An attempt at the run's provider call begins. Repeats while the run is open, once per attempt.
 */
export interface ModelStartedData {
  readonly runId: string;
  /** The model the run's participants chose. */
  readonly modelId: string;
  /**
   * Which try at this model step this is: 0 for the first. A run that replaces one a retry gave
   * up (after it published output) continues the count, so a run's first attempt can be above 0.
   */
  readonly attempt: number;
}

/** The estimator that produced a composition's token counts. */
export type ModelCompositionEstimator = "eve-bytes-4" | (string & {});

/**
 * Estimated input tokens of one assembled request, by category. Estimates, not provider tokenizer
 * counts. `total` is `system + tools + history`; `toolOutputs` and `summaries` are parts of
 * `history`, never added to it.
 */
export interface ModelCompositionTokens {
  /** System instructions. */
  readonly system: number;
  /** Tool definitions: names, descriptions and input schemas. */
  readonly tools: number;
  /** Every non-system message. */
  readonly history: number;
  /** The part of `history` that is tool results. */
  readonly toolOutputs: number;
  /** The part of `history` that is a compaction summary at its head. */
  readonly summaries: number;
  readonly total: number;
}

/**
 * What one provider call was sent, measured on the assembled, provider-neutral request (after eve's
 * framing, attachments and cache markers, before the provider adapter serializes it).
 */
export interface ModelComposedData {
  readonly runId: string;
  /** The attempt this send belongs to, as on `model.started`. */
  readonly attempt: number;
  /** Which send within the attempt: above 0 when the model client resent the same request. */
  readonly send: number;
  /** The provider adapter that received the request, such as `anthropic.messages` or `gateway`. */
  readonly provider: string;
  /** The model id the provider adapter was asked for. */
  readonly providerModelId: string;
  /** Non-system messages in the request. */
  readonly messages: number;
  readonly estimator: ModelCompositionEstimator;
  readonly tokens: ModelCompositionTokens;
  /**
   * SHA-256 (hex) of the request's tool definitions and system instructions, the prefix a
   * provider's prompt cache can reuse across calls. Excludes headers, provider options, cache
   * markers and provider tool arguments.
   */
  readonly prefixHash: string;
  /** SHA-256 (hex) of the prefix and every message's content, on the same terms as `prefixHash`. */
  readonly requestHash: string;
  /** Prompt-cache requests in the request: explicit cache markers, and the gateway's caching mode. */
  readonly cache: { readonly markers: number; readonly gateway?: string };
}

/** An attempt failed, and the same run tries again. The run's status doesn't change. */
export interface ModelRetriedData {
  readonly runId: string;
  /** The attempt that failed. */
  readonly attempt: number;
  readonly error: ErrorInfo;
}

/** How a model run ended, as recorded on `model.settled`. */
export type ModelOutcome = "completed" | "failed" | "interrupted" | "abandoned";

/** The payload of `model.settled`: a model run ends, with its outcome and the provider's finish reason. */
export interface ModelSettledData {
  readonly runId: string;
  readonly outcome: ModelOutcome;
  /** The provider's finish reason, as an open string: `stop`, `tool-calls`, `length`, …. */
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
}

/** The fact that introduces a model run. */
export type ModelRequested = Envelope<"model.requested", ModelRequestedData>;
/** The fact recording that an attempt at a model run's provider call began. */
export type ModelStarted = Envelope<"model.started", ModelStartedData>;
/** The fact recording what one provider call of a model run's attempt was sent. */
export type ModelComposed = Envelope<"model.composed", ModelComposedData>;
/** The fact recording that a model run's attempt failed and the run tries again. */
export type ModelRetried = Envelope<"model.retried", ModelRetriedData>;
/** The terminal fact of a model run. */
export type ModelSettled = Envelope<"model.settled", ModelSettledData>;
/** Any fact in the `model` family. */
export type ModelFact = ModelRequested | ModelStarted | ModelComposed | ModelRetried | ModelSettled;

const attempt = z.number().int().nonnegative();

const owner = conforming<ModelOwner>()(
  z.union([z.object({ turnId: id }), z.object({ changeId: id })]),
);

const tokenCount = z.number().int().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const modelSchemas = {
  "model.composed": envelopeOf(
    "model.composed",
    conforming<ModelComposedData>()(
      z.object({
        attempt,
        cache: z.object({ gateway: z.string().optional(), markers: tokenCount }),
        estimator: z.string(),
        messages: tokenCount,
        prefixHash: hash,
        provider: z.string(),
        providerModelId: z.string(),
        requestHash: hash,
        runId: id,
        send: tokenCount,
        tokens: z.object({
          history: tokenCount,
          summaries: tokenCount,
          system: tokenCount,
          toolOutputs: tokenCount,
          tools: tokenCount,
          total: tokenCount,
        }),
      }),
    ),
  ),
  "model.requested": envelopeOf(
    "model.requested",
    conforming<ModelRequestedData>()(z.object({ owner, runId: id })),
  ),
  "model.retried": envelopeOf(
    "model.retried",
    conforming<ModelRetriedData>()(z.object({ attempt, error: errorInfo, runId: id })),
  ),
  "model.settled": envelopeOf(
    "model.settled",
    conforming<ModelSettledData>()(
      z.object({
        error: errorInfo.optional(),
        finishReason: z.string().optional(),
        generationId: z.string().optional(),
        outcome: known<ModelOutcome>(),
        runId: id,
      }),
    ),
  ),
  "model.started": envelopeOf(
    "model.started",
    conforming<ModelStartedData>()(z.object({ attempt, modelId: z.string(), runId: id })),
  ),
};

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";

import { type LanguageModel, wrapLanguageModel } from "ai";

import { resolvedLanguageModel } from "#harness/model-call/unique-call-ids.js";
import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createHash } from "#platform/crypto.js";
import type { ModelComposedData } from "#protocol/session-events/families/model.js";

export const COMPOSITION_ESTIMATOR = "eve-bytes-4";

export type Composition = Omit<ModelComposedData, "runId" | "attempt" | "send">;

export function withComposition(
  model: LanguageModel,
  onComposed: (composition: Composition, send: number) => Promise<void>,
): LanguageModel {
  return wrapLanguageModel({
    middleware: compositionMiddleware(onComposed),
    model: resolvedLanguageModel(model),
  });
}

function compositionMiddleware(
  onComposed: (composition: Composition, send: number) => Promise<void>,
): LanguageModelV4Middleware {
  let sends = 0;
  return {
    specificationVersion: "v4",
    transformParams: async ({ model, params }) => {
      const send = sends++;
      const composition = composeOrSkip(params, model);
      if (composition !== undefined) await onComposed(composition, send);
      return params;
    },
  };
}

function composeOrSkip(
  params: LanguageModelV4CallOptions,
  model: LanguageModelV4,
): Composition | undefined {
  try {
    return composeRequest(params, model);
  } catch {
    return undefined;
  }
}

export function composeRequest(
  params: Pick<LanguageModelV4CallOptions, "prompt" | "tools" | "providerOptions">,
  model: Pick<LanguageModelV4, "provider" | "modelId">,
): Composition {
  const system = params.prompt.filter((message) => message.role === "system");
  const history = params.prompt.filter((message) => message.role !== "system");
  const tools = params.tools ?? [];
  const tokens = {
    history: sum(history.map((message) => estimateTokens(sent(message)))),
    summaries: sum(headSummary(history).map((message) => estimateTokens(sent(message)))),
    system: sum(system.map((message) => estimateTokens(message.content))),
    toolOutputs: sum(history.flatMap(toolResults).map((part) => estimateTokens(sent(part)))),
    tools: estimateTokens(tools.map(toolDefinition)),
  };
  const prefix = {
    system: system.map((message) => message.content),
    tools: tools.map(toolDefinition),
  };
  const gateway = (params.providerOptions?.gateway as { caching?: unknown } | undefined)?.caching;
  return {
    cache: {
      markers: cacheMarkers([...params.prompt, ...tools]),
      ...(typeof gateway === "string" && { gateway }),
    },
    estimator: COMPOSITION_ESTIMATOR,
    messages: history.length,
    prefixHash: hashOf(prefix),
    provider: model.provider,
    providerModelId: model.modelId,
    requestHash: hashOf({ ...prefix, messages: history.map(sent) }),
    tokens: { ...tokens, total: tokens.system + tokens.tools + tokens.history },
  };
}

function toolDefinition(tool: NonNullable<LanguageModelV4CallOptions["tools"]>[number]) {
  return tool.type === "function"
    ? {
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
        type: tool.type,
      }
    : { id: tool.id, name: tool.name, type: tool.type };
}

function toolResults(message: LanguageModelV4Message): readonly object[] {
  if (message.role !== "tool" && message.role !== "assistant") return [];
  return message.content.filter((part) => part.type === "tool-result");
}

function headSummary(
  history: readonly LanguageModelV4Message[],
): readonly LanguageModelV4Message[] {
  const [marker, summary] = history;
  const isMarker =
    marker?.role === "user" &&
    marker.content.length === 1 &&
    marker.content[0]?.type === "text" &&
    marker.content[0].text === COMPACTION_CHECKPOINT_MARKER;
  return isMarker && summary?.role === "assistant" ? [marker, summary] : [];
}

function sent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sent);
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  if (value instanceof URL || value instanceof ArrayBuffer) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "providerOptions")
      .map(([key, entry]) => [key, sent(entry)]),
  );
}

function cacheMarkers(entries: readonly object[]): number {
  let markers = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return;
    const options = (value as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
      .providerOptions;
    if (options?.anthropic?.cacheControl !== undefined) markers++;
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) visit(content);
  };
  visit(entries);
  return markers;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value instanceof URL) return JSON.stringify(value.href);
  if (value instanceof ArrayBuffer) return canonical(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return JSON.stringify(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

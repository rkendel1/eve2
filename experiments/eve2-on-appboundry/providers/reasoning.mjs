// reasoning.interpret@1 over Claude (Anthropic Messages API, official SDK). The model is this provider's choice and
// is replaceable; the consumer sees a contract: instructions + request + JSON schema in, a schema-valid result and the
// call's usage out. A refusal or an unusable answer is an AppPort error, never an invented result.
import Anthropic from "@anthropic-ai/sdk";
import { defineCapability } from "@appport/core";
import { AppPortError } from "@appport/protocol";
import { s } from "@appport/schema";
import { log, serve } from "./serve.mjs";

const MODEL = process.env.REASONING_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.REASONING_EFFORT ?? "medium";
const client = new Anthropic({ apiKey: process.env.BENCH_API_KEY ?? process.env.ANTHROPIC_API_KEY });
if (!process.env.BENCH_API_KEY && !process.env.ANTHROPIC_API_KEY) log("reasoning.unconfigured", { message: "No BENCH_API_KEY or ANTHROPIC_API_KEY: every call will be refused as provider.UNAVAILABLE." });

/** A failure of the model call itself, logged with its cause and reported as a protocol error (never a silent INTERNAL). */
function modelFailure(error) {
  if (error instanceof AppPortError) return error;
  const status = error?.status;
  log("model.error", { status: status ?? null, type: error?.name, message: String(error?.message ?? error).slice(0, 300) });
  if (status === 429) return new AppPortError("RATE_LIMITED", "The model provider is rate limiting; try again later.");
  if (status === 400) return new AppPortError("INVALID_INPUT", `The model rejected the request: ${String(error?.message ?? "").slice(0, 200)}`);
  return new AppPortError("provider.UNAVAILABLE", `The model could not be reached (${status ?? error?.name ?? "error"}).`);
}
const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };

const interpret = defineCapability({
  name: "reasoning.interpret", version: 1,
  description: "Interpret a person's request into a structured result that matches the given JSON schema. Returns the result and the model call's usage.",
  input: s.object({ instructions: s.string(), request: s.string(), context: s.optional(s.string()), schema: s.unknown() }),
  output: s.object({ result: s.unknown(), usage: s.unknown() }),
  authorization: [], idempotency: "supported",
  handler: async ({ instructions, request, context, schema }) => {
    const started = Date.now();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: instructions,
      messages: [{ role: "user", content: context ? `${request}\n\n${context}` : request }],
    }).catch((e) => { throw modelFailure(e); });
    const usage = {
      provider: "anthropic", requested: MODEL, served: response.model, effort: EFFORT, stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0, latencyMs: Date.now() - started, messageId: response.id,
    };
    totals.calls++; totals.inputTokens += usage.inputTokens; totals.outputTokens += usage.outputTokens;
    log("interpret", { ...usage, totals });
    if (response.stop_reason === "refusal") throw new AppPortError("FORBIDDEN", `The model declined (${response.stop_details?.category ?? "no category"}).`);
    if (response.stop_reason === "max_tokens") throw new AppPortError("INTERNAL_ERROR", "The model's answer was cut off.");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let result;
    try { result = JSON.parse(text); } catch { throw new AppPortError("INTERNAL_ERROR", "The model did not return JSON."); }
    return { result, usage };
  },
});

const DECIDE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["act", "finish"] },
    action: { anyOf: [{ type: "string" }, { type: "null" }] },
    inputJson: { anyOf: [{ type: "string" }, { type: "null" }] },
    resultJson: { anyOf: [{ type: "string" }, { type: "null" }] },
    rationale: { type: "string" },
  },
  required: ["kind", "action", "inputJson", "resultJson", "rationale"],
  additionalProperties: false,
};

const decide = defineCapability({
  name: "reasoning.decide", version: 1,
  description: "Choose the single next action toward an objective from the actions offered, given what has been observed; or finish with a result in the requested shape. Executes nothing.",
  input: s.object({ objective: s.string(), guidance: s.string(), actions: s.unknown(), observations: s.string(), resultShape: s.string() }),
  output: s.object({ decision: s.unknown(), usage: s.unknown() }),
  authorization: [], idempotency: "supported",
  handler: async ({ objective, guidance, actions, observations, resultShape }) => {
    const started = Date.now();
    const system = [
      "You direct an operator that works on a software repository through a fixed set of actions. You never execute anything yourself: each turn you choose exactly one action from the list, with its input, or you finish.",
      "Work from evidence: read and search before concluding, cite exact files and lines, and run a check when a claim depends on behavior. Do not repeat an action whose result you already have.",
      "Reply with kind \"act\", the action name and inputJson (a JSON object string matching that action's input), or kind \"finish\" and resultJson (a JSON string in the result shape).",
      guidance,
    ].join("\n");
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: process.env.DECIDE_EFFORT ?? "high", format: { type: "json_schema", schema: DECIDE_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      // The history only grows: one block per observation keeps every earlier block a cacheable prefix of the next call.
      messages: [{ role: "user", content: [
        { type: "text", text: `Actions:\n${JSON.stringify(actions, null, 1)}\n\nResult shape when finishing:\n${resultShape}\n\nWhat you have done and observed so far, oldest first:` },
        // The breakpoint goes on the newest observation, not on the objective after it (which changes every call).
        ...(observations ? observations.split(/\n\n(?=#\d+ )/) : ["(nothing yet)"]).map((text, i, all) => ({ type: "text", text, ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) })),
        { type: "text", text: `Objective:\n${objective}` },
      ] }],
    }).catch((e) => { throw modelFailure(e); });
    const usage = {
      provider: "anthropic", requested: MODEL, served: response.model, stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started, messageId: response.id,
    };
    totals.calls++; totals.inputTokens += usage.inputTokens; totals.outputTokens += usage.outputTokens;
    log("decide", { ...usage, totals });
    if (response.stop_reason === "refusal") throw new AppPortError("FORBIDDEN", `The model declined (${response.stop_details?.category ?? "no category"}).`);
    if (response.stop_reason === "max_tokens") throw new AppPortError("INTERNAL_ERROR", "The model's answer was cut off.");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let decision;
    try { decision = JSON.parse(text); } catch { throw new AppPortError("INTERNAL_ERROR", "The model did not return JSON."); }
    return { decision, usage };
  },
});

serve({ id: "reasoning-claude", name: "Claude reasoning", capabilities: [interpret, decide], port: Number(process.env.PORT ?? 5410), consumerToken: process.env.CONSUMER_TOKEN });

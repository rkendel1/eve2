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
    });
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

serve({ id: "reasoning-claude", name: "Claude reasoning", capabilities: [interpret], port: Number(process.env.PORT ?? 5410), consumerToken: process.env.CONSUMER_TOKEN });

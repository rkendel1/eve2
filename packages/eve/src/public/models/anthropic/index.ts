import type { LanguageModel } from "ai";
import { createAnthropic } from "#compiled/@ai-sdk/anthropic/index.js";
import { createDirectModelFetch, type DirectModelOptions } from "#internal/model-auth/transport.js";

export type { DirectModelOptions } from "#internal/model-auth/transport.js";

/**
 * Creates a direct Anthropic model that never routes through AI Gateway. Uses `options.apiKey`
 * when given; otherwise ANTHROPIC_API_KEY, or /login credentials in local development.
 */
export function anthropic(
  model = "claude-sonnet-5",
  options: DirectModelOptions = {},
): Exclude<LanguageModel, string> {
  const id = model.trim().replace(/^anthropic\//u, "");
  if (!id || id.includes("/")) throw new Error("Expected an Anthropic model ID.");
  return createAnthropic({
    apiKey: "eve-local-credential",
    ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
    fetch: createDirectModelFetch("anthropic", options),
  })(id);
}

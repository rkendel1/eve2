import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
import { readModelSecret, modelKeySecretName } from "./store.js";

const KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "ai-gateway-key": "AI_GATEWAY_API_KEY",
} as const;

export async function resolveModelApiKey(provider: keyof typeof KEY_ENV): Promise<string> {
  const value = process.env[KEY_ENV[provider]];
  const source =
    isEveDevEnvironment() && process.env[MODEL_CONNECTION_ENV] === provider
      ? process.env.EVE_MODEL_KEY_SOURCE
      : undefined;
  const environmentKey = value?.trim() ? value : undefined;
  if (environmentKey !== undefined && source !== "secret") return environmentKey;
  if (isEveDevEnvironment() && source !== "environment") {
    const stored = await readModelSecret(modelKeySecretName(provider)).catch((error: unknown) => {
      if (environmentKey === undefined) throw error;
      return undefined;
    });
    if (stored) return stored;
  }
  if (environmentKey !== undefined) return environmentKey;
  if (source === "secret")
    throw new Error("The selected saved API key is unavailable. Run /login to reconnect.");
  throw new Error(
    `Set ${KEY_ENV[provider]}${isEveDevEnvironment() ? " or connect with /login" : " in the server environment"}.`,
  );
}

import { createGateway, type LanguageModel } from "ai";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { resolveModelApiKey } from "./api-key.js";
import {
  developmentModelBrokerAvailable,
  readDevelopmentModelCredential,
} from "./development-broker-client.js";
import { resolveGatewayModelCredential } from "./gateway-credential.js";
import { VERCEL_TEAM_HEADER } from "./vercel.js";
import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";

export { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
export { resolveModelApiKey } from "./api-key.js";

/** Explicit provider settings for a direct model, in place of the provider's environment key. */
export interface DirectModelOptions {
  /**
   * The provider API key, or a function eve calls before each request, for example to read a
   * rotated secret. When set, eve sends it as given and reads neither the environment key nor
   * `/login` credentials.
   */
  readonly apiKey?: string | (() => string | Promise<string>);
  /** The provider API's base URL, such as a proxy or a regional endpoint. @default the provider's */
  readonly baseURL?: string;
}

export function createDirectModelFetch(
  provider: "openai" | "anthropic",
  options: DirectModelOptions = {},
): typeof fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    const { apiKey } = options;
    const key =
      apiKey === undefined
        ? ((await readDevelopmentModelCredential(provider, undefined, init?.signal))?.token ??
          (await resolveModelApiKey(provider)))
        : typeof apiKey === "string"
          ? apiKey
          : await apiKey();
    if (key.trim().length === 0) throw new Error(`The ${provider} apiKey option is empty.`);
    headers.set(
      provider === "openai" ? "authorization" : "x-api-key",
      provider === "openai" ? `Bearer ${key}` : key,
    );
    return fetch(url, { ...init, headers });
  };
}

function createLocalGateway(): ReturnType<typeof createGateway> | undefined {
  if (!isEveDevEnvironment()) return undefined;
  if (Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") != null) return undefined;
  const selected = process.env[MODEL_CONNECTION_ENV];
  if (
    !developmentModelBrokerAvailable() &&
    selected !== "vercel" &&
    selected !== "vercel-cli" &&
    selected !== "ai-gateway-key" &&
    selected !== "ai-gateway-project"
  )
    return undefined;
  const resolve = async (rejectedToken?: string, signal?: AbortSignal | null) =>
    (await readDevelopmentModelCredential("gateway", rejectedToken, signal)) ??
    (await resolveGatewayModelCredential(rejectedToken));
  return createGateway({
    apiKey: "eve-local-credential",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const authenticate = (credential: Awaited<ReturnType<typeof resolve>>) => {
        headers.set("authorization", `Bearer ${credential.token}`);
        headers.delete(VERCEL_TEAM_HEADER);
        if (credential.teamId) headers.set(VERCEL_TEAM_HEADER, credential.teamId);
      };
      const credential = await resolve(undefined, init?.signal);
      authenticate(credential);
      const response = await fetch(url, { ...init, headers });
      if (
        response.status !== 401 ||
        credential.kind !== "oauth" ||
        (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      )
        return response;
      await response.body?.cancel();
      authenticate(await resolve(credential.token, init?.signal));
      return fetch(url, { ...init, headers });
    },
  });
}

export function localGatewayModel(id: string): LanguageModel | undefined {
  return createLocalGateway()?.languageModel(id);
}

export function localGatewayDecisionModel(
  id: string,
): ReturnType<ReturnType<typeof createGateway>["decisionModel"]> | undefined {
  return createLocalGateway()?.decisionModel(id);
}

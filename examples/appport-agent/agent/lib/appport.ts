import { createHmac, randomUUID } from "node:crypto";

import { createClient } from "@appport/client";
import type { AppRequest, AppResponse } from "@appport/protocol";
import { createHttpTransport } from "@appport/transport-http";

const ASSERTION_TTL_SECONDS = 60;

export interface Caller {
  readonly principalId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

function callerAssertion(caller: Caller): string {
  const secret = requireEnv("APPPORT_AGENT_ASSERTION_SECRET");
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    act: "appport-agent",
    aud: "appport:inventory",
    exp: now + ASSERTION_TTL_SECONDS,
    iat: now,
    iss: "appport-agent",
    jti: randomUUID(),
    sub: caller.principalId,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function clientFor(caller: Caller) {
  return createClient({
    transport: createHttpTransport({
      headers: { authorization: `Bearer ${callerAssertion(caller)}` },
      url: requireEnv("APPPORT_URL"),
    }),
  });
}

function allowedCapabilities(): ReadonlySet<string> {
  return new Set(
    (process.env.APPPORT_AGENT_CAPABILITIES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export interface CapabilitySummary {
  readonly authorization: readonly string[];
  readonly description?: string;
  readonly effect?: string;
  readonly invocable: boolean;
  readonly name: string;
  readonly version: number;
}

export async function listCapabilities(caller: Caller): Promise<CapabilitySummary[]> {
  const manifest = await clientFor(caller).load();
  const allowed = allowedCapabilities();
  return manifest.capabilities
    .filter((entry) => !entry.name.startsWith("appport."))
    .map((entry) => ({
      authorization: entry.authorization,
      description: entry.description,
      effect: entry.effect,
      invocable: entry.effect === "observation" && allowed.has(entry.name),
      name: entry.name,
      version: entry.latestVersion,
    }));
}

export async function readContract(caller: Caller, name: string) {
  const manifest = await clientFor(caller).load();
  const entry = manifest.capabilities.find((candidate) => candidate.name === name);
  if (entry === undefined) return { found: false as const, name };
  return {
    authorization: entry.authorization,
    description: entry.description,
    effect: entry.effect,
    found: true as const,
    inputSchema: entry.inputSchema,
    name: entry.name,
    outputSchema: entry.outputSchema,
    version: entry.latestVersion,
  };
}

export type InvocationResult =
  | {
      readonly authorizationDecision?: unknown;
      readonly ok: true;
      readonly output: unknown;
      readonly requestId: string;
    }
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
      readonly ok: false;
      readonly requestId: string;
    };

export async function invokeCapability(
  caller: Caller,
  name: string,
  input: unknown,
  traceId: string | undefined,
): Promise<InvocationResult> {
  const requestId = `eve_${randomUUID()}`;
  const client = clientFor(caller);
  const entry = (await client.load()).capabilities.find((candidate) => candidate.name === name);
  if (entry === undefined || entry.effect !== "observation" || !allowedCapabilities().has(name)) {
    return {
      error: {
        code: "NOT_EXPOSED",
        message: `This agent may only invoke read-only capabilities its operator allows; ${name} is not one of them.`,
      },
      ok: false,
      requestId,
    };
  }
  const request: AppRequest = {
    capability: { name, version: entry.latestVersion },
    input,
    protocol: "appport/1",
    requestId,
    type: "request",
  };
  if (traceId !== undefined) request.traceId = traceId;
  const response: AppResponse = await client.send(request);
  if (response.type !== "response") {
    return {
      error: { code: "UNEXPECTED_RESPONSE", message: "AppPort returned a non-response envelope." },
      ok: false,
      requestId,
    };
  }
  return response.ok
    ? {
        authorizationDecision: response.authorizationDecision,
        ok: true,
        output: response.output,
        requestId,
      }
    : { error: response.error, ok: false, requestId };
}

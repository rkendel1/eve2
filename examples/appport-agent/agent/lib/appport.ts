import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient } from "@appport/client";
import type { AppRequest, AppResponse } from "@appport/protocol";
import { createHttpTransport } from "@appport/transport-http";

export interface Caller {
  readonly principalId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

function agentCredential(): string {
  return readFileSync(requireEnv("APPPORT_AGENT_CREDENTIAL_FILE"), "utf8").trim();
}

function clientFor(caller: Caller) {
  return createClient({
    transport: createHttpTransport({
      headers: {
        authorization: `Bearer ${agentCredential()}`,
        "x-appport-on-behalf-of": caller.principalId,
      },
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
  const unavailable = (error: unknown): InvocationResult => ({
    error: {
      code: "UNAVAILABLE",
      message: `AppPort did not answer: ${error instanceof Error ? error.message : String(error)}`,
    },
    ok: false,
    requestId,
  });
  const client = clientFor(caller);
  let entry;
  try {
    entry = (await client.load()).capabilities.find((candidate) => candidate.name === name);
  } catch (error) {
    return unavailable(error);
  }
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
  let response: AppResponse;
  try {
    response = await client.send(request);
  } catch (error) {
    return unavailable(error);
  }
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

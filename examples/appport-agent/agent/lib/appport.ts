import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient } from "@appport/client";
import type { AppRequest, AppResponse, CapabilityManifestEntry } from "@appport/protocol";
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

function onBehalfOf(caller: Caller): string {
  if (process.env.APPPORT_ON_BEHALF_OF !== "subject") return caller.principalId;
  const prefix = `${process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator"}:`;
  if (!caller.principalId.startsWith(prefix))
    throw new Error(
      `${caller.principalId} was not issued by ${prefix.slice(0, -1)}; it names no person here.`,
    );
  return caller.principalId.slice(prefix.length);
}

function clientFor(caller: Caller) {
  return createClient({
    transport: createHttpTransport({
      headers: {
        authorization: `Bearer ${agentCredential()}`,
        "x-appport-on-behalf-of": onBehalfOf(caller),
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
  readonly idempotency: string;
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
      idempotency: entry.idempotency ?? "unsupported",
      invocable: allowed.has(entry.name),
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

export type ResolvedCapability =
  | { readonly ok: true; readonly entry: CapabilityManifestEntry }
  | { readonly ok: false; readonly result: InvocationResult };

function refused(requestId: string, code: string, message: string): InvocationResult {
  return { error: { code, message }, ok: false, requestId };
}

function unavailable(requestId: string, error: unknown): InvocationResult {
  return refused(
    requestId,
    "UNAVAILABLE",
    `AppPort did not answer: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function resolveCapability(caller: Caller, name: string): Promise<ResolvedCapability> {
  const requestId = `eve_${randomUUID()}`;
  let entry;
  try {
    entry = (await clientFor(caller).load()).capabilities.find(
      (candidate) => candidate.name === name,
    );
  } catch (error) {
    return { ok: false, result: unavailable(requestId, error) };
  }
  if (entry === undefined || !allowedCapabilities().has(name)) {
    return {
      ok: false,
      result: refused(
        requestId,
        "NOT_EXPOSED",
        `This agent may only invoke capabilities its operator allows; ${name} is not one of them.`,
      ),
    };
  }
  return { entry, ok: true };
}

export async function sendRequest(
  caller: Caller,
  entry: CapabilityManifestEntry,
  input: unknown,
  traceId: string | undefined,
  idempotencyKey: string | undefined,
): Promise<InvocationResult> {
  const requestId = `eve_${randomUUID()}`;
  const request: AppRequest = {
    capability: { name: entry.name, version: entry.latestVersion },
    input,
    protocol: "appport/1",
    requestId,
    type: "request",
  };
  if (traceId !== undefined) request.traceId = traceId;
  if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey;
  let response: AppResponse;
  try {
    response = await clientFor(caller).send(request);
  } catch (error) {
    return unavailable(requestId, error);
  }
  if (response.type !== "response")
    return refused(requestId, "UNEXPECTED_RESPONSE", "AppPort returned a non-response envelope.");
  return response.ok
    ? {
        authorizationDecision: response.authorizationDecision,
        ok: true,
        output: response.output,
        requestId,
      }
    : { error: response.error, ok: false, requestId };
}

export async function invokeCapability(
  caller: Caller,
  name: string,
  input: unknown,
  traceId: string | undefined,
): Promise<InvocationResult> {
  const resolved = await resolveCapability(caller, name);
  if (!resolved.ok) return resolved.result;
  if (resolved.entry.effect !== "observation") {
    return refused(
      `eve_${randomUUID()}`,
      "NOT_EXPOSED",
      `${name} changes state; it is invoked only through a durable operation within accepted work.`,
    );
  }
  return await sendRequest(caller, resolved.entry, input, traceId, undefined);
}

import { createHmac } from "node:crypto";

import { CALLBACK_ALLOWED_ORIGINS_ENV } from "#internal/workspace/callback-origins.js";

export const WORKSPACE_SECRET_ENV = "EVE_WORKSPACE_SECRET";
export const WORKSPACE_AGENT_ENV = "EVE_WORKSPACE_AGENT";
export const WORKSPACE_PEERS_ENV = "EVE_WORKSPACE_PEERS";
export {
  CALLBACK_ALLOWED_ORIGINS_ENV,
  isAllowedCallbackOrigin,
} from "#internal/workspace/callback-origins.js";
export const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

export const WORKSPACE_HOST_ENV_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_LOCAL_BASE_URL_ENV,
  WORKSPACE_SECRET_ENV,
  WORKSPACE_AGENT_ENV,
  WORKSPACE_PEERS_ENV,
  CALLBACK_ALLOWED_ORIGINS_ENV,
]);

export const WORKSPACE_TOKEN_ISSUER = "eve-workspace";
const WORKSPACE_TOKEN_TTL_SECONDS = 300;
const MINIMUM_SECRET_LENGTH = 32;

export function workspaceTokenAudience(agentName: string): string {
  return `${WORKSPACE_TOKEN_ISSUER}:${agentName}`;
}

export function workspacePrincipalSubject(agentName: string): string {
  return agentName;
}

export function readWorkspaceSecret(): string | undefined {
  const secret = process.env[WORKSPACE_SECRET_ENV];
  if (secret === undefined || secret.length === 0) return undefined;
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `${WORKSPACE_SECRET_ENV} must be at least ${MINIMUM_SECRET_LENGTH} characters long.`,
    );
  }
  return secret;
}

export function readWorkspacePeers(): Readonly<Record<string, string>> | undefined {
  const raw = process.env[WORKSPACE_PEERS_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${WORKSPACE_PEERS_ENV} must be a JSON object of agent names to origins.`);
  }
  const peers: Record<string, string> = {};
  for (const [name, origin] of Object.entries(parsed)) {
    if (typeof origin !== "string") {
      throw new Error(`${WORKSPACE_PEERS_ENV} has a non-string origin for agent "${name}".`);
    }
    peers[name] = new URL(origin).origin;
  }
  return peers;
}

export function mintWorkspacePeerToken(input: {
  readonly callee: string;
  readonly caller: string;
  readonly now?: number;
  readonly secret: string;
}): string {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    aud: workspaceTokenAudience(input.callee),
    exp: issuedAt + WORKSPACE_TOKEN_TTL_SECONDS,
    iat: issuedAt,
    iss: WORKSPACE_TOKEN_ISSUER,
    sub: workspacePrincipalSubject(input.caller),
  });
  const signature = createHmac("sha256", input.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

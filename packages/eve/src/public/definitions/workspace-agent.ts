import type { HeadersValue } from "#client/types.js";
import { type OutboundAuthFn, vercelOidc } from "#public/agents/auth.js";
import {
  defineRemoteAgent,
  type RemoteAgentDefinition,
  type RemoteAgentUrl,
} from "#public/definitions/remote-agent.js";
import { normalizePublicRoutePrefix } from "#shared/public-route-prefix.js";
import {
  mintWorkspacePeerToken,
  readWorkspacePeers,
  readWorkspaceSecret,
  WORKSPACE_AGENT_ENV,
} from "#internal/workspace/peer-auth.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";

const WORKSPACE_AGENT_NAME = Symbol.for("eve.workspace-agent.name");

type BrandedWorkspaceSubagent = RemoteAgentDefinition & {
  readonly [WORKSPACE_AGENT_NAME]: string;
};

/** Runtime transport for one workspace peer. */
export interface WorkspaceAgentTransport {
  readonly auth?: OutboundAuthFn;
  readonly headers?: HeadersValue;
  readonly url: RemoteAgentUrl;
}

/** A workspace peer exposed as one remote subagent. */
export interface WorkspaceAgentDefinition {
  /** Overrides the peer agent's description in the parent's tool definition. */
  readonly description?: string;
  readonly forwardPrincipal?: boolean;
  /** Name of the peer workspace member, such as `research`. */
  readonly name: string;
  /**
   * How eve exposes this workspace peer to the parent model: `true` lists it
   * as a tool, `"deferred"` makes it a catalog entry the model finds with
   * `eve__search` and calls with `eve__tool`, and `false` keeps it callable only from
   * workflow tools. Defaults to `true`.
   */
  readonly tool?: AgentToolExposure;
  /** Overrides environment-aware workspace routing and service authentication. */
  readonly transport?: WorkspaceAgentTransport;
}

/** Defines one workspace peer as a remote subagent. */
export function defineWorkspaceAgent(definition: WorkspaceAgentDefinition): RemoteAgentDefinition {
  const transport = definition.transport ?? defaultWorkspaceAgentTransport(definition.name);
  const remote = defineRemoteAgent({
    auth: transport.auth,
    description: definition.description ?? "",
    forwardPrincipal: definition.forwardPrincipal,
    headers: transport.headers,
    tool: definition.tool,
    url: transport.url,
  }) as BrandedWorkspaceSubagent;
  Object.defineProperty(remote, WORKSPACE_AGENT_NAME, { value: definition.name });
  return remote;
}

export function workspaceSubagentName(value: unknown): string | undefined {
  return isBrandedWorkspaceSubagent(value) ? value[WORKSPACE_AGENT_NAME] : undefined;
}

function isBrandedWorkspaceSubagent(value: unknown): value is BrandedWorkspaceSubagent {
  return typeof value === "object" && value !== null && Reflect.has(value, WORKSPACE_AGENT_NAME);
}

function workspaceAgentRoutePrefix(name: string): string {
  const callerRoutePrefix = normalizePublicRoutePrefix(process.env.EVE_PUBLIC_ROUTE_PREFIX);
  const namespace =
    callerRoutePrefix?.slice(0, callerRoutePrefix.lastIndexOf("/")) ??
    (process.env.VERCEL_ENV === "development" ? "" : "/eve");
  return `${namespace}/${name}`;
}

function defaultWorkspaceAgentTransport(name: string): WorkspaceAgentTransport {
  const auth = vercelOidc();
  return {
    auth: async () => {
      if (!process.env.VERCEL) return { headers: selfHostedWorkspacePeerHeaders(name) };
      return process.env.VERCEL_ENV === "development" ? { headers: {} } : auth();
    },
    url: () => {
      if (!process.env.VERCEL) return selfHostedWorkspacePeerOrigin(name);
      const development = process.env.VERCEL_ENV === "development";
      const host =
        process.env.VERCEL_ENV === "production"
          ? process.env.VERCEL_PROJECT_PRODUCTION_URL
          : process.env.VERCEL_URL;
      if (host === undefined || host.length === 0) {
        throw new Error(
          "The default workspace-agent transport requires VERCEL_URL, or VERCEL_PROJECT_PRODUCTION_URL in production.",
        );
      }
      return `${development ? "http" : "https"}://${host}${workspaceAgentRoutePrefix(name)}`;
    },
  };
}

function selfHostedWorkspacePeerOrigin(name: string): string {
  const peers = readWorkspacePeers();
  if (peers === undefined) {
    throw new Error(
      "No default workspace-agent transport is available in this environment. Run the workspace with `eve start` from its root, deploy it to Vercel, or provide transport to defineWorkspaceAgent().",
    );
  }
  const origin = peers[name];
  if (origin === undefined) {
    throw new Error(
      `Workspace agent "${name}" is not running in this workspace. Running agents: ${Object.keys(peers).join(", ")}.`,
    );
  }
  return origin;
}

function selfHostedWorkspacePeerHeaders(name: string): Record<string, string> {
  const secret = readWorkspaceSecret();
  const caller = process.env[WORKSPACE_AGENT_ENV];
  if (secret === undefined || caller === undefined || caller.length === 0) {
    throw new Error(
      "The self-hosted workspace-agent transport requires the agent to run under `eve start` from the workspace root.",
    );
  }
  return {
    authorization: `Bearer ${mintWorkspacePeerToken({ callee: name, caller, secret })}`,
  };
}

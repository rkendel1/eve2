import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import {
  resolveListenPort,
  startProductionServer,
} from "#internal/nitro/host/start-production-server.js";
import type { ProductionServerHandle } from "#internal/nitro/host/types.js";
import type { AgentWorkspace } from "#internal/project-context.js";
import { readDevelopmentEnvironmentValues } from "#shared/development-env-files.js";
import {
  CALLBACK_ALLOWED_ORIGINS_ENV,
  readWorkspaceSecret,
  WORKFLOW_LOCAL_BASE_URL_ENV,
  WORKSPACE_AGENT_ENV,
  WORKSPACE_PEERS_ENV,
  WORKSPACE_SECRET_ENV,
} from "./peer-auth.js";

const MEMBER_HOST = "127.0.0.1";
const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["v1"]);

export interface WorkspaceHostAgent {
  readonly name: string;
  readonly origin: string;
  readonly routePrefix: string;
}

export interface WorkspaceHostHandle extends ProductionServerHandle {
  readonly agents: readonly WorkspaceHostAgent[];
}

interface RunningMember extends WorkspaceHostAgent {
  alive: boolean;
  readonly appRoot: string;
  readonly server: ProductionServerHandle;
}

export async function startWorkspaceHost(
  workspace: AgentWorkspace,
  options: { readonly host?: string; readonly port?: number; readonly schedules?: boolean } = {},
): Promise<WorkspaceHostHandle> {
  for (const member of workspace.members) {
    if (RESERVED_AGENT_NAMES.has(member.name)) {
      throw new Error(
        `A workspace agent cannot be named "${member.name}" when served by eve start.`,
      );
    }
  }
  await loadDevelopmentEnvironmentFiles(workspace.root);
  const secret = readWorkspaceSecret() ?? randomBytes(32).toString("base64url");

  const planned = await Promise.all(
    workspace.members.map(async (member) => {
      const port = await resolveListenPort({ host: MEMBER_HOST, port: 0 });
      return { ...member, origin: `http://${MEMBER_HOST}:${port}`, port };
    }),
  );
  const peers = Object.fromEntries(planned.map((member) => [member.name, member.origin]));
  const callbackOrigins = planned.map((member) => member.origin).join(",");

  const members: RunningMember[] = [];
  try {
    for (const member of planned) {
      const server = await startProductionServer(member.appRoot, {
        env: {
          ...Object.fromEntries(readDevelopmentEnvironmentValues(member.appRoot)),
          [CALLBACK_ALLOWED_ORIGINS_ENV]: callbackOrigins,
          [WORKFLOW_LOCAL_BASE_URL_ENV]: member.origin,
          [WORKSPACE_AGENT_ENV]: member.name,
          [WORKSPACE_PEERS_ENV]: JSON.stringify(peers),
          [WORKSPACE_SECRET_ENV]: secret,
        },
        host: MEMBER_HOST,
        loadEnvironmentFiles: false,
        port: member.port,
        schedules: options.schedules,
      });
      const running: RunningMember = {
        alive: true,
        appRoot: member.appRoot,
        name: member.name,
        origin: member.origin,
        routePrefix: `/eve/${member.name}`,
        server,
      };
      void server.wait().then(
        () => (running.alive = false),
        () => (running.alive = false),
      );
      members.push(running);
    }
  } catch (error) {
    await Promise.allSettled(members.map((member) => member.server.close()));
    throw error;
  }

  const router = createServer((request, response) => route(members, request, response));
  const host = options.host ?? "0.0.0.0";
  const port = await resolveListenPort({ host, port: options.port ?? environmentPort() ?? 3000 });
  await new Promise<void>((resolveListen, rejectListen) => {
    router.once("error", rejectListen);
    router.listen(port, host, () => resolveListen());
  });
  const closed = new Promise<void>((resolveClosed) => router.once("close", () => resolveClosed()));
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    agents: members.map(({ name, origin, routePrefix }) => ({ name, origin, routePrefix })),
    async close() {
      await new Promise<void>((resolveClose) => router.close(() => resolveClose()));
      router.closeAllConnections();
      await Promise.allSettled(members.map((member) => member.server.close()));
    },
    url: `http://${clientHost}:${port}/`,
    wait: () => closed,
  };
}

function route(
  members: readonly RunningMember[],
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "http://workspace.invalid");
  if (url.pathname === "/eve/v1/health") {
    const agents = members.map((member) => ({
      name: member.name,
      ok: member.alive,
      routePrefix: member.routePrefix,
    }));
    const ok = agents.every((agent) => agent.ok);
    sendJson(response, ok ? 200 : 503, {
      agents,
      ok,
      status: ok ? "ready" : "degraded",
    });
    return;
  }

  const match = /^\/eve\/([^/]+)(\/v1\/.*|\/?)$/u.exec(url.pathname);
  const member = match === null ? undefined : members.find((entry) => entry.name === match[1]);
  if (match === null || member === undefined) {
    sendJson(response, 404, {
      code: "agent_not_found",
      error: `No workspace agent serves ${url.pathname}.`,
      ok: false,
    });
    return;
  }
  if (!member.alive) {
    sendJson(response, 503, {
      code: "agent_unavailable",
      error: `Workspace agent "${member.name}" is not running.`,
      ok: false,
    });
    return;
  }

  const rest = match[2] ?? "";
  const path = `${rest.startsWith("/v1/") ? `/eve${rest}` : "/"}${url.search}`;
  proxy(member, path, request, response);
}

function proxy(
  member: RunningMember,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const target = new URL(member.origin);
  const upstream = httpRequest(
    {
      headers: {
        ...request.headers,
        host: target.host,
        "x-forwarded-host": request.headers.host ?? "",
        "x-forwarded-proto": "http",
      },
      hostname: target.hostname,
      method: request.method,
      path,
      port: target.port,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 502, {
      code: "agent_unavailable",
      error: `Workspace agent "${member.name}" did not respond.`,
      ok: false,
    });
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function environmentPort(): number | undefined {
  const raw = process.env.PORT?.trim();
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `Invalid PORT environment variable "${raw}". Expected an integer between 0 and 65535.`,
    );
  }
  return port;
}

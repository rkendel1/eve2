import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import {
  startPackagedEveStart,
  withoutVercelEnv,
  type RunningEveStart,
} from "./eve-start-harness.js";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));
const AUTH = { basic: { username: "alice", password: "fixture" } };
const WORKSPACE_SECRET = "self-hosted-workspace-secret-0123456789abcdef";

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;
let server: RunningEveStart;

const coordinatorModel = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(async (request) => {
    const taskResult = [...request.messages]
      .reverse()
      .find((entry) => entry.role !== "system" && entry.text.includes("<task_result"));
    if (taskResult !== undefined) {
      return /status="(failed|error|cancelled)"|"isError":true|failed/iu.test(taskResult.text)
        ? \`Delegation failed: \${taskResult.text}\`
        : \`Coordinator relays: \${taskResult.text}\`;
    }
    const [result] = request.toolResults;
    if (result === undefined) {
      return { toolCalls: [{ name: "research", input: { message: request.lastUserMessage ?? "" } }] };
    }
    return result.isError
      ? \`Delegation failed: \${JSON.stringify(result.output)}\`
      : "Waiting for research.";
  }),
  modelContextWindowTokens: 32_000,
});
`;

const researchModel = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(async (request) => {
    const message = request.lastUserMessage ?? "";
    if (message.includes("crash")) process.exit(1);
    if (message.includes("fail")) throw new Error("research backend is down");
    if (request.toolResults.length === 0) return { toolCalls: [{ name: "whoami", input: {} }] };
    return \`Research found PELICAN-42 as \${JSON.stringify(request.toolResults[0]?.output)}\`;
  }),
  modelContextWindowTokens: 32_000,
});
`;

const spanFileExporter = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: {
    export(spans, done) {
      for (const span of spans) {
        const context = span.spanContext();
        appendFileSync(
          join(process.cwd(), "spans.jsonl"),
          JSON.stringify({
            attributes: span.attributes,
            links: (span.links ?? []).map((link) => ({
              attributes: link.attributes,
              spanId: link.context.spanId,
              traceId: link.context.traceId,
            })),
            name: span.name,
            parentSpanId: span.parentSpanContext?.spanId ?? span.parentSpanId,
            spanId: context.spanId,
            traceId: context.traceId,
          }) + "\\n",
        );
      }
      done({ code: 0 });
    },
    async shutdown() {},
  },
});
`;

function signWorkspaceToken(secret: string, audience: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: "eve-workspace",
    sub: "intruder",
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function runTurn(message: string): Promise<{ outcome: string; reply: string }> {
  const { session } = await new Client({
    baseUrl: new URL("/eve/coordinator", server.url).toString(),
    auth: AUTH,
  }).sessions.create();
  await session.send(message);
  let reply = "";
  for await (const event of session.stream({ signal: AbortSignal.timeout(120_000) })) {
    if (event.type === "content.completed" && event.data.kind === "text") {
      reply = String(event.data.value);
    }
    if (
      event.type === "turn.settled" &&
      (event.data.outcome !== "completed" || /^(Coordinator relays|Delegation failed)/u.test(reply))
    ) {
      return { outcome: event.data.outcome, reply };
    }
  }
  return { outcome: "unsettled", reply };
}

beforeAll(async () => {
  app = await materializeScenarioApp({
    name: "self-hosted-workspace",
    installDependencies: true,
    files: {
      "agents/coordinator/agent/agent.ts": coordinatorModel,
      "agents/coordinator/agent/instructions.md": "Delegate research to the research agent.\n",
      "agents/coordinator/agent/instrumentation/spans.ts": spanFileExporter,
      "agents/coordinator/agent/subagents/research.ts": `import { defineWorkspaceAgent } from "eve/experimental/workspace";

export default defineWorkspaceAgent({ name: "research", description: "Researches facts." });
`,
      "agents/coordinator/agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });
`,
      "agents/research/agent/agent.ts": researchModel,
      "agents/research/agent/instructions.md": "Answer research questions.\n",
      "agents/research/agent/instrumentation/spans.ts": spanFileExporter,
      "agents/research/agent/tools/whoami.ts": `import { defineTool } from "eve/tools";

export default defineTool({
  description: "Report the principal this session runs as.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    const current = ctx.session.auth?.current;
    return { principalId: current?.principalId, principalType: current?.principalType };
  },
});
`,
      "agents/research/agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";
import { workspacePeers } from "eve/experimental/workspace";

export default eveChannel({ auth: workspacePeers() });
`,
    },
  });
  await promisify(execFile)(process.execPath, [EVE_BIN_PATH, "build"], {
    cwd: app.appRoot,
    env: withoutVercelEnv({ EVE_MODEL_CATALOG: "bundled" }),
    maxBuffer: 64 * 1024 * 1024,
  });
  server = await startPackagedEveStart(app.appRoot, {
    env: withoutVercelEnv({ EVE_WORKSPACE_SECRET: WORKSPACE_SECRET }),
  });
}, 600_000);

afterAll(async () => {
  await server?.stop();
  await app?.cleanup();
});

describe("self-hosted multi-agent workspace", () => {
  it("builds every member as a Node server from the workspace root", () => {
    for (const name of ["coordinator", "research"]) {
      expect(existsSync(join(app.appRoot, "agents", name, ".output/server/index.mjs"))).toBe(true);
    }
  });

  it("serves every agent from one origin and reports each one's health", async () => {
    const health = await fetch(new URL("/eve/v1/health", server.url));
    expect(health.status, server.stderr()).toBe(200);
    expect(await health.json()).toEqual({
      agents: [
        { name: "coordinator", ok: true, routePrefix: "/eve/coordinator" },
        { name: "research", ok: true, routePrefix: "/eve/research" },
      ],
      ok: true,
      status: "ready",
    });
    for (const name of ["coordinator", "research"]) {
      const agentHealth = await fetch(new URL(`/eve/${name}/v1/health`, server.url));
      expect(agentHealth.status).toBe(200);
    }
    expect((await fetch(new URL("/eve/billing/v1/health", server.url))).status).toBe(404);
  });

  it("delegates to a peer that runs as the calling agent, not as the end user", async () => {
    const { outcome, reply } = await runTurn("Please research the codeword.");

    expect(outcome, server.stderr()).toBe("completed");
    expect(reply).toContain("Coordinator relays:");
    expect(reply).toContain("PELICAN-42");
    expect(reply).toContain('"principalId":"eve-workspace:coordinator"');
    expect(reply).toContain('"principalType":"service"');
    expect(reply).not.toContain("alice");
  });

  it("exports nested and linked traces through OpenTelemetry without Vercel", async () => {
    type ExportedSpan = {
      attributes: Record<string, unknown>;
      links: { attributes: Record<string, unknown>; spanId: string; traceId: string }[];
      name: string;
      parentSpanId?: string;
      spanId: string;
      traceId: string;
    };
    const read = (agent: string): ExportedSpan[] => {
      const path = join(app.appRoot, "agents", agent, "spans.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ExportedSpan);
    };
    await expect
      .poll(() => read("research").some((span) => span.name.startsWith("invoke_agent")), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect
      .poll(() => read("coordinator").some((span) => span.name === "execute_tool research"), {
        timeout: 30_000,
      })
      .toBe(true);

    const coordinator = read("coordinator");
    const tool = coordinator.find((span) => span.name === "execute_tool research")!;
    const ancestors = new Set<string>();
    for (
      let parent = coordinator.find((span) => span.spanId === tool.parentSpanId);
      parent !== undefined;
      parent = coordinator.find((span) => span.spanId === parent!.parentSpanId)
    ) {
      expect(parent.traceId).toBe(tool.traceId);
      ancestors.add(parent.name);
    }
    expect([...ancestors].some((name) => name.startsWith("invoke_agent"))).toBe(true);

    const research = read("research").find((span) => span.name.startsWith("invoke_agent"))!;
    expect(research.traceId).not.toBe(tool.traceId);
    expect(
      read("research").some((span) =>
        span.links.some(
          (link) =>
            link.traceId === tool.traceId && link.attributes["eve.link.type"] === "agent.dispatch",
        ),
      ),
    ).toBe(true);

    const exported = JSON.stringify([...coordinator, ...read("research")]);
    expect(exported).not.toContain("Please research the codeword");
  });

  it("rejects callers that are not workspace peers", async () => {
    const create = (headers: Record<string, string>) =>
      fetch(new URL("/eve/research/v1/session", server.url), { headers, method: "POST" });
    const basic = `Basic ${Buffer.from("alice:fixture").toString("base64")}`;

    expect((await create({})).status).toBe(401);
    expect((await create({ authorization: basic })).status).toBe(401);
    expect(
      (
        await create({
          authorization: `Bearer ${signWorkspaceToken("not-the-workspace-secret-0123456789", "eve-workspace:research")}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await create({
          authorization: `Bearer ${signWorkspaceToken(WORKSPACE_SECRET, "eve-workspace:coordinator")}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await create({
          authorization: `Bearer ${signWorkspaceToken(WORKSPACE_SECRET, "eve-workspace:research")}`,
        })
      ).status,
    ).toBe(202);
  });

  it("returns a delegated agent's failure to the caller", async () => {
    const { outcome, reply } = await runTurn("Please fail this research.");

    expect(outcome, server.stderr()).toBe("completed");
    expect(reply).toContain("Delegation failed:");
  });

  it("reports a stopped peer in workspace health and fails new delegations to it", async () => {
    const crash = await fetch(new URL("/eve/research/v1/session", server.url), {
      body: JSON.stringify({ message: "Please crash now." }),
      headers: {
        authorization: `Bearer ${signWorkspaceToken(WORKSPACE_SECRET, "eve-workspace:research")}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(crash.status).toBe(202);

    await expect
      .poll(async () => (await fetch(new URL("/eve/v1/health", server.url))).status, {
        timeout: 30_000,
      })
      .toBe(503);
    const unavailable = await fetch(new URL("/eve/research/v1/health", server.url));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "agent_unavailable" });

    const afterCrash = await runTurn("Please research the codeword again.");
    expect(afterCrash.outcome, server.stderr()).toBe("completed");
    expect(afterCrash.reply).toContain("Delegation failed:");
    expect((await fetch(new URL("/eve/coordinator/v1/health", server.url))).status).toBe(200);
  }, 300_000);
});

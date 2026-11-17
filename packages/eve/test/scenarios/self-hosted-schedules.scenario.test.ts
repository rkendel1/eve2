import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import {
  isVercelEnvName,
  startPackagedEveStart,
  withoutVercelEnv,
  type RunningEveStart,
} from "./eve-start-harness.js";

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

type Occurrence = { executionId: string; name: string; note: string; scheduledAt: string };

function occurrences(): Occurrence[] {
  const path = join(app.appRoot, "occurrences.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Occurrence);
}

async function manage(
  server: RunningEveStart,
  user: "alice" | "bob",
  input: Record<string, unknown>,
): Promise<unknown> {
  const { session } = await new Client({
    baseUrl: server.url,
    auth: { basic: { username: user, password: "fixture" } },
  }).sessions.create();
  await session.send(JSON.stringify(input));
  let reply = "";
  for await (const event of session.stream({ signal: AbortSignal.timeout(90_000) })) {
    if (event.type === "content.completed" && event.data.kind === "text") {
      reply = String(event.data.value);
    }
    if (event.type === "turn.settled") break;
  }
  const parsed = JSON.parse(reply) as { error?: string; result?: unknown };
  if (parsed.error !== undefined) throw new Error(`${parsed.error}\n${server.stderr()}`);
  return parsed.result;
}

function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16);
}

beforeAll(async () => {
  for (const name of Object.keys(process.env)) {
    if (isVercelEnvName(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("EVE_MODEL_CATALOG", "bundled");
  try {
    app = await materializeScenarioApp({
      name: "self-hosted-schedules",
      installDependencies: true,
      dependencies: { zod: "4.6.7" },
      files: {
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(async (request) => {
    const [result] = request.toolResults;
    if (result === undefined) {
      return { toolCalls: [{ name: "manage", input: JSON.parse(request.lastUserMessage ?? "{}") }] };
    }
    return JSON.stringify(result.isError ? { error: JSON.stringify(result.output) } : { result: result.output });
  }),
  modelContextWindowTokens: 32_000,
});
`,
        "agent/instructions.md": "Manage reminders.\n",
        "agent/schedules/reminders.ts": `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamicSchedules } from "eve/experimental/schedules";
import { workflowScheduleProvider } from "eve/experimental/schedules/workflow";
import { z } from "zod";

export default defineDynamicSchedules({
  provider: workflowScheduleProvider(),
  inputSchema: z.object({ note: z.string() }).strict(),
  auth: async ({ principal }) => ({
    attributes: {},
    authenticator: principal.authenticator,
    issuer: principal.issuer,
    subject: principal.subject,
    principalId: principal.principalId,
    principalType: principal.type,
  }),
  async run({ payload, occurrence }) {
    appendFileSync(
      join(process.cwd(), "occurrences.log"),
      JSON.stringify({
        executionId: occurrence.executionId,
        name: occurrence.name,
        note: payload.note,
        scheduledAt: occurrence.scheduledAt,
      }) + "\\n",
    );
  },
});
`,
        "agent/tools/manage.ts": `import { schedules } from "eve/experimental/schedules";
import { defineTool } from "eve/tools";
import { z } from "zod";
import reminders from "../schedules/reminders";

export default defineTool({
  description: "Manage reminders.",
  inputSchema: z.object({
    operation: z.enum(["create", "list", "get", "disable", "enable", "update", "invoke", "delete"]),
    name: z.string().optional(),
    at: z.string().optional(),
    cron: z.string().optional(),
    note: z.string().optional(),
  }),
  async execute(input) {
    const client = await schedules(reminders);
    const expression =
      input.cron !== undefined
        ? { type: "cron" as const, cron: input.cron }
        : input.at !== undefined
          ? { type: "single" as const, at: input.at }
          : undefined;
    switch (input.operation) {
      case "create":
        return await client.create({ expression: expression!, name: input.name!, payload: { note: input.note ?? "" } });
      case "list":
        return (await client.list({ limit: 100 })).data;
      case "get":
        return await client.get(input.name!);
      case "disable":
        return await client.disable(input.name!);
      case "enable":
        return await client.enable(input.name!);
      case "update":
        return await client.update(input.name!, { expression: expression! });
      case "invoke":
        await client.invoke(input.name!);
        return { invoked: true };
      case "delete":
        return { deleted: await client.delete(input.name!) };
    }
  },
});
`,
        "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

const USERS = new Set(["alice", "bob"]);

export default eveChannel({
  auth: (request) => {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Basic ")) return null;
    const [user, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (user === undefined || !USERS.has(user) || password !== "fixture") return null;
    return { attributes: {}, authenticator: "fixture", principalId: user, principalType: "user" };
  },
});
`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });
  } finally {
    vi.unstubAllEnvs();
  }
}, 600_000);

afterAll(async () => {
  await app?.cleanup();
});

describe("self-hosted durable dynamic schedules", () => {
  it("fires a one-time schedule that came due while the server was down, exactly once", async () => {
    const due = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
    let server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    let created: { name: string; state: string };
    try {
      created = (await manage(server, "alice", {
        operation: "create",
        name: "downtime",
        at: utcMinute(due),
        note: "while down",
      })) as { name: string; state: string };
      expect(created.state).toBe("active");
    } finally {
      await server.crash();
    }

    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.max(0, due.getTime() - Date.now() + 5_000)),
    );
    expect(occurrences()).toEqual([]);

    server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await expect.poll(() => occurrences().length, { timeout: 90_000, interval: 500 }).toBe(1);
      expect(occurrences()[0]).toMatchObject({
        name: created.name,
        note: "while down",
        scheduledAt: due.toISOString(),
      });
      await expect
        .poll(
          async () =>
            (
              (await manage(server, "alice", { operation: "get", name: created.name })) as {
                state: string;
              } | null
            )?.state,
          {
            timeout: 30_000,
          },
        )
        .toBe("completed");
    } finally {
      await server.stop();
    }

    server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
      expect(occurrences()).toHaveLength(1);
    } finally {
      await server.stop();
    }
  }, 420_000);

  it("keeps schedule management state across a restart and isolates principals", async () => {
    let server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    let name: string;
    try {
      const created = (await manage(server, "alice", {
        operation: "create",
        name: "yearly",
        cron: "0 0 1 1 *",
        note: "new year",
      })) as { name: string; state: string };
      name = created.name;
      expect(created.state).toBe("active");
      const disabled = (await manage(server, "alice", { operation: "disable", name })) as {
        state: string;
      };
      expect(disabled.state).toBe("inactive");
    } finally {
      await server.crash();
    }

    server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      expect(await manage(server, "alice", { operation: "get", name })).toMatchObject({
        name,
        state: "inactive",
      });
      expect(await manage(server, "bob", { operation: "list" })).toEqual([]);
      await expect(manage(server, "bob", { operation: "get", name })).resolves.toBeNull();

      expect(await manage(server, "alice", { operation: "enable", name })).toMatchObject({
        state: "active",
      });
      expect(
        await manage(server, "alice", { operation: "update", name, cron: "30 6 * * 1" }),
      ).toMatchObject({ expression: { type: "cron", cron: "30 6 * * 1" }, state: "active" });

      const before = occurrences().length;
      await manage(server, "alice", { operation: "invoke", name });
      expect(occurrences()).toHaveLength(before + 1);
      expect(occurrences().at(-1)).toMatchObject({ name, note: "new year" });

      expect(await manage(server, "alice", { operation: "delete", name })).toEqual({
        deleted: true,
      });
      await expect(manage(server, "alice", { operation: "get", name })).resolves.toBeNull();
    } finally {
      await server.stop();
    }
  }, 300_000);
});

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";
import { buildAndStartEve, type RunningEveServer } from "#internal/testing/built-server-harness.js";

const SETUP_TIMEOUT_MS = 360_000;
const TEST_TIMEOUT_MS = 240_000;
const SERVER_ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const UPGRADE_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  experimental: { workflow: { retention: "default" } },
  model: mockModel(async (request) => \`ECHO:\${request.lastUserMessage ?? ""}\`),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/thread.ts": `import { defineChannel, GET, POST } from "eve/channels";

export default defineChannel({
  routes: [
    POST("/thread/:id", async (request, { from, params }) => {
      const { message } = await request.json();
      const delivery = await from(params.id).send(message, { auth: null });
      return Response.json({ sessionId: delivery.sessionId });
    }),
    GET("/thread-session/:sessionId", async (_request, { attachSession, params }) => {
      const events = [];
      try {
        for await (const event of attachSession(params.sessionId).stream({ follow: false })) {
          events.push({ data: event.data, type: event.type });
        }
      } catch (error) {
        return Response.json({ code: error?.code, error: String(error) }, { status: 500 });
      }
      return Response.json(events);
    }),
  ],
});
`,
    "agent/instructions.md": "Reply with the deterministic mock model.\n",
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "session-upgrade",
};

interface RecordedEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

let app: Awaited<ReturnType<typeof materializeScenarioApp>> | undefined;
let server: RunningEveServer | undefined;

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, server!.url), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function events(sessionId: string): Promise<RecordedEvent[]> {
  const response = await fetch(new URL(`/thread-session/${sessionId}`, server!.url));
  expect(response.status).toBe(200);
  return (await response.json()) as RecordedEvent[];
}

async function settledReply(sessionId: string): Promise<RecordedEvent[]> {
  let recorded: RecordedEvent[] = [];
  await expect
    .poll(
      async () => {
        recorded = await events(sessionId);
        return recorded.some((event) => event.type === "turn.settled");
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return recorded;
}

async function rewrite(path: string, change: (content: string) => string): Promise<void> {
  const content = await readFile(path, "utf8");
  await rm(path);
  await writeFile(path, change(content));
}

async function upgradeInstalledEve(appRoot: string): Promise<string> {
  const packageRoot = join(appRoot, "node_modules", "eve");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const upgraded = `${manifest.version}-upgraded.1`;
  await rewrite(
    join(packageRoot, "package.json"),
    () => `${JSON.stringify({ ...manifest, version: upgraded }, null, 2)}\n`,
  );
  await rewrite(
    join(packageRoot, "dist", "src", "internal", "application", "stamped-package-version.js"),
    (content) => content.replace(`\`${manifest.version}\``, `\`${upgraded}\``),
  );
  return upgraded;
}

describe("sessions across an eve upgrade", () => {
  beforeAll(async () => {
    app = await materializeScenarioApp(UPGRADE_DESCRIPTOR);
    server = await buildAndStartEve(app.appRoot, SERVER_ENV);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await app?.cleanup().catch(() => {});
  });

  it(
    "replaces a session parked by the previous eve version and keeps its history readable",
    async () => {
      const first = String((await post("/thread/alice-thread", { message: "first" })).sessionId);
      const before = await settledReply(first);
      const previousVersion = (
        before.find((event) => event.type === "session.started")?.data.runtime as {
          eveVersion?: string;
        }
      )?.eveVersion;
      expect(previousVersion).toEqual(expect.any(String));

      await server!.stop();
      const upgradedVersion = await upgradeInstalledEve(app!.appRoot);
      server = await buildAndStartEve(app!.appRoot, SERVER_ENV);

      const second = String((await post("/thread/alice-thread", { message: "second" })).sessionId);
      expect(second).not.toBe(first);

      const after = await settledReply(second);
      const started = after.find((event) => event.type === "session.started");
      expect(started?.data).toMatchObject({
        predecessor: { sessionId: first },
        runtime: { eveVersion: upgradedVersion },
      });
      expect(
        after.some(
          (event) =>
            event.type === "delivery.consumed" &&
            JSON.stringify(event.data.parts).includes("second"),
        ),
      ).toBe(true);

      const retired = await events(first);
      expect(retired.some((event) => event.type === "session.ended")).toBe(true);
      expect(
        retired.some(
          (event) =>
            event.type === "delivery.consumed" &&
            JSON.stringify(event.data.parts).includes("second"),
        ),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";
import {
  buildEve,
  startBuiltEve,
  type RunningEveServer,
} from "#internal/testing/built-server-harness.js";
import { createWorkClient, type WorkClient } from "#public/channels/work-client.js";

const SETUP_TIMEOUT_MS = 360_000;
const TEST_TIMEOUT_MS = 120_000;
const SERVER_ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(async (request) => \`ECHO:\${request.lastUserMessage ?? ""}\`),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/work.ts": `import { workChannel } from "eve/channels/work";

export default workChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    if (principalId === null) return null;
    return { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  },
});
`,
    "agent/instructions.md": "Reply with the deterministic mock model.\n",
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "work-channel-instances",
};

let app: Awaited<ReturnType<typeof materializeScenarioApp>> | undefined;
const servers: RunningEveServer[] = [];

function client(server: RunningEveServer): WorkClient {
  return createWorkClient({ baseUrl: server.url, headers: { "x-test-principal": "alice" } });
}

async function settled(work: WorkClient, sessionId: string, attempts: number) {
  await expect
    .poll(
      async () => {
        const status = await work.status(sessionId);
        return status.attempts >= attempts && status.attempt?.status === "settled";
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return await work.status(sessionId);
}

describe("two eve instances sharing one local World", () => {
  beforeAll(async () => {
    app = await materializeScenarioApp(DESCRIPTOR);
    await buildEve(app.appRoot, SERVER_ENV);
    servers.push(await startBuiltEve(app.appRoot, SERVER_ENV));
    servers.push(await startBuiltEve(app.appRoot, SERVER_ENV));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await app?.cleanup().catch(() => {});
  });

  it(
    "serves one piece of work from either instance",
    async () => {
      const [a, b] = servers.map(client) as [WorkClient, WorkClient];
      const submitted = await a.submit({ objective: "first" }, { idempotencyKey: "shared-1" });
      await expect(
        b.submit({ objective: "first" }, { idempotencyKey: "shared-1" }),
      ).resolves.toMatchObject({ replayed: true, sessionId: submitted.sessionId });
      await expect(
        b.submit({ objective: "other" }, { idempotencyKey: "shared-1" }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused" });

      expect(await settled(b, submitted.sessionId, 1)).toMatchObject({ reply: "ECHO:first" });

      await b.steer(submitted.sessionId, "second");
      expect(await settled(a, submitted.sessionId, 2)).toMatchObject({
        attempts: 2,
        reply: "ECHO:second",
      });
      await expect(b.result(submitted.sessionId)).resolves.toMatchObject({
        outcome: "completed",
        reply: "ECHO:second",
      });
    },
    TEST_TIMEOUT_MS,
  );
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";
import { startEveDev, type RunningEveDev } from "#internal/testing/dev-server-harness.js";
import { createWorkClient, type WorkClient } from "#public/channels/work-client.js";

const SETUP_TIMEOUT_MS = 360_000;
const TEST_TIMEOUT_MS = 90_000;
const RESULTS_FILE = "work-results.ndjson";

const WORK_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel(async (request) => {
  const last = request.lastUserMessage ?? "";
  if (last.includes("WORK-SLOW")) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    return "WORK-SLOW-DONE";
  }
  return \`ECHO:\${last}\`;
});

export default defineAgent({
  description: "Exercises the work channel.",
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/work.ts": `import { appendFile } from "node:fs/promises";
import { workChannel } from "eve/channels/work";

export default workChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    if (principalId === null) return null;
    return { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  },
  onResult: async (result) => {
    await appendFile(${JSON.stringify(RESULTS_FILE)}, JSON.stringify(result) + "\\n");
  },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "work-channel",
};

let app: Awaited<ReturnType<typeof materializeScenarioApp>> | undefined;
let server: RunningEveDev | undefined;

function client(principal: string | null): WorkClient {
  if (server === undefined) throw new Error("eve dev is not running.");
  return createWorkClient({
    baseUrl: server.url,
    headers: principal === null ? {} : { "x-test-principal": principal },
  });
}

async function settled(work: WorkClient, sessionId: string, attempts = 1) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await work.status(sessionId);
    if (status.attempts >= attempts && status.attempt?.status === "settled") return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Work ${sessionId} did not settle.`);
}

describe("work channel", () => {
  beforeAll(async () => {
    app = await materializeScenarioApp(WORK_AGENT_DESCRIPTOR);
    server = await startEveDev(app.appRoot, {
      env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await app?.cleanup().catch(() => {});
  });

  it(
    "runs submitted work once per key and reports its result to its owner only",
    async () => {
      const alice = client("alice");
      const submitted = await alice.submit(
        { objective: "WORK-ECHO count the stock" },
        { idempotencyKey: "order-1" },
      );
      expect(submitted).toMatchObject({ replayed: false });
      expect(submitted.controls.pause.supported).toBe(false);
      expect(submitted.controls.interrupt).toMatchObject({
        preemptsModelStep: true,
        supported: true,
      });

      const status = await settled(alice, submitted.sessionId);
      expect(status).toMatchObject({
        attempts: 1,
        reply: "ECHO:WORK-ECHO count the stock",
        status: "completed",
        version: 1,
      });
      expect(status.runner?.eveVersion).toEqual(expect.any(String));
      await expect(alice.result(submitted.sessionId)).resolves.toMatchObject({
        outcome: "completed",
        reply: "ECHO:WORK-ECHO count the stock",
        turnId: status.attempt?.turnId,
      });

      await expect(
        alice.submit({ objective: "WORK-ECHO count the stock" }, { idempotencyKey: "order-1" }),
      ).resolves.toMatchObject({ replayed: true, sessionId: submitted.sessionId });
      await expect(
        alice.submit({ objective: "WORK-ECHO something else" }, { idempotencyKey: "order-1" }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused", status: 409 });
      expect((await alice.status(submitted.sessionId)).attempts).toBe(1);

      await expect(client("bob").status(submitted.sessionId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(client(null).status(submitted.sessionId)).rejects.toMatchObject({
        status: 401,
      });

      const lines = [];
      for await (const event of alice.events(submitted.sessionId)) {
        lines.push(event);
        if (event.cursor === status.cursor) break;
      }
      expect(lines.map((event) => event.position)).toEqual(
        Array.from({ length: status.cursor }, (_, index) => index),
      );
      const tail = [];
      for await (const event of alice.events(submitted.sessionId, { cursor: status.cursor - 1 })) {
        tail.push(event);
        break;
      }
      expect(tail[0]?.position).toBe(status.cursor - 1);

      await expect
        .poll(async () =>
          (await readFile(join(app!.appRoot, RESULTS_FILE), "utf8").catch(() => ""))
            .split("\n")
            .filter((line) => line.includes(submitted.sessionId)),
        )
        .toHaveLength(1);
      const [reported] = (await readFile(join(app!.appRoot, RESULTS_FILE), "utf8"))
        .split("\n")
        .filter((line) => line.includes(submitted.sessionId));
      expect(JSON.parse(reported!)).toMatchObject({
        outcome: "completed",
        sessionId: submitted.sessionId,
        turnId: status.attempt?.turnId,
        workspace: null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "interrupts a running attempt, starts the next with a message, and stops the work",
    async () => {
      const alice = client("alice");
      const { sessionId } = await alice.submit(
        { objective: "WORK-SLOW prepare the report" },
        { idempotencyKey: "slow-1" },
      );
      await expect.poll(async () => (await alice.status(sessionId)).status).toBe("running");
      await alice.interrupt(sessionId);
      const interrupted = await settled(alice, sessionId);
      expect(interrupted).toMatchObject({ attempt: { outcome: "cancelled" }, status: "cancelled" });

      await alice.steer(sessionId, "WORK-ECHO continue");
      const next = await settled(alice, sessionId, 2);
      expect(next).toMatchObject({ attempts: 2, reply: "ECHO:WORK-ECHO continue" });

      await alice.stop(sessionId);
      await expect.poll(async () => (await alice.status(sessionId)).status).toBe("ended");
      await expect(alice.steer(sessionId, "WORK-ECHO again")).rejects.toMatchObject({
        status: 409,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

const AUTH = { basic: { username: "alice", password: "fixture" } };
const RUN_NONCE = randomUUID();

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

function templateImageReference(): string {
  const manifest = JSON.parse(
    readFileSync(join(app.appRoot, ".output/.eve/compile/sandbox-prepared-artifacts.json"), "utf8"),
  ) as { entries: { artifact: { provider: string; artifact: { imageReference: string } } }[] };
  const [entry] = manifest.entries;
  expect(entry?.artifact.provider).toBe("docker");
  return entry!.artifact.artifact.imageReference;
}

async function runTurn(server: RunningEveStart, message: string) {
  const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
  await session.send(message);
  let reply = "";
  for await (const event of session.stream({ signal: AbortSignal.timeout(180_000) })) {
    if (event.type === "content.completed" && event.data.kind === "text") {
      reply = String(event.data.value);
    }
    if (event.type === "turn.settled") return { outcome: event.data.outcome, reply };
  }
  return { outcome: "unsettled", reply };
}

function removeTemplateImage(reference: string): void {
  const containers = execFileSync("docker", ["ps", "-aq", "--filter", `ancestor=${reference}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .filter(Boolean);
  if (containers.length > 0)
    execFileSync("docker", ["rm", "-f", ...containers], { stdio: "ignore" });
  execFileSync("docker", ["image", "rm", "-f", reference], { stdio: "ignore" });
}

beforeAll(async () => {
  for (const name of Object.keys(process.env)) {
    if (isVercelEnvName(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    app = await materializeScenarioApp({
      name: "self-hosted-runtime",
      installDependencies: true,
      files: {
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(async (request) => {
    const message = request.lastUserMessage ?? "";
    if (message.includes("kernel")) {
      if (request.toolResults.length === 0) {
        return { toolCalls: [{ name: "bash", input: { command: "uname -s && echo selfhost-sandbox-ok" } }] };
      }
      return \`Sandbox said: \${JSON.stringify(request.toolResults[0]?.output)}\`;
    }
    if (message.includes("Remember")) {
      if (request.toolResults.length === 0) {
        return { toolCalls: [{ name: "file__save_memory", input: { text: "Alice's codeword is PELICAN-42." } }] };
      }
      return "Saved.";
    }
    return request.messages.some((entry) => entry.text.includes("PELICAN-42"))
      ? "Recalled PELICAN-42."
      : "Nothing recalled.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
        "agent/instructions.md": "Run the command Alice asks for.\n",
        "agent/memory/file.ts": `import { defineMemory } from "eve/memory";
import { fileMemory, localFiles } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  provider: fileMemory({ backend: localFiles() }),
  scope: byPrincipal,
});
`,
        "agent/sandbox/sandbox.ts": `import { DefaultSandbox, defineSandbox } from "eve/sandbox";

export const environment = DefaultSandbox.environment({
  docker: { env: { EVE_SELF_HOSTED_TEST_RUN: "${RUN_NONCE}" } },
});
export default defineSandbox(() => environment.open());
`,
        "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });
`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: false });
  } finally {
    vi.unstubAllEnvs();
  }
}, 600_000);

afterAll(async () => {
  if (app !== undefined) {
    try {
      removeTemplateImage(templateImageReference());
    } catch {}
    await app.cleanup();
  }
});

describe("self-hosted runtime: Docker sandbox and file memory", () => {
  it("reports a ready template at startup and runs bash in a Docker container", async () => {
    const reference = templateImageReference();
    const server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await expect
        .poll(() => server.stdout(), { timeout: 15_000 })
        .toContain(`sandbox: docker template ${reference} is ready.`);

      const { outcome, reply } = await runTurn(server, "Alice asks for the kernel name.");
      expect(outcome, server.stderr()).toBe("completed");
      expect(reply).toContain("selfhost-sandbox-ok");
      expect(reply).toContain("Linux");
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("keeps localFiles() memory across an eve start restart", async () => {
    let server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await expect(runTurn(server, "Remember Alice's codeword.")).resolves.toEqual({
        outcome: "completed",
        reply: "Saved.",
      });
    } finally {
      await server.crash();
    }
    expect(readdirSync(join(app.appRoot, ".eve/memory"))).toHaveLength(1);

    server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await expect(runTurn(server, "What do you recall about Alice?")).resolves.toEqual({
        outcome: "completed",
        reply: "Recalled PELICAN-42.",
      });
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("warns at startup when the runtime daemon lacks the template the build prepared", async () => {
    const reference = templateImageReference();
    removeTemplateImage(reference);

    const server = await startPackagedEveStart(app.appRoot, { env: withoutVercelEnv() });
    try {
      await expect
        .poll(() => server.stdout(), { timeout: 15_000 })
        .toContain(`template image ${reference} is missing on this Docker daemon`);
      const health = await fetch(new URL("/eve/v1/health", server.url));
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 120_000);
});

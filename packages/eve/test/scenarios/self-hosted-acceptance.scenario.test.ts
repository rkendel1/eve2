import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
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

const JWT_SECRET = "self-hosted-acceptance-secret-0123456789abcdef";
const JWT_ISSUER = "self-hosted-acceptance";
const JWT_AUDIENCE = "eve-self-hosted";
const ANTHROPIC_API_KEY = process.env.EVE_ACCEPTANCE_ANTHROPIC_API_KEY?.trim() ?? "";
const ANTHROPIC_MODEL = process.env.EVE_ACCEPTANCE_ANTHROPIC_MODEL?.trim() || "claude-sonnet-5";

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

function selfHostedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return withoutVercelEnv({
    ACCEPTANCE_JWT_SECRET: JWT_SECRET,
    ACCEPTANCE_MODEL: ANTHROPIC_MODEL,
    ...extra,
  });
}

function signJwt(secret: string, claims: Record<string, unknown> = {}): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: "alice",
    iat: now,
    exp: now + 600,
    ...claims,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function settledReplies(server: RunningEveStart, sessionId: string, turns: number) {
  const session = new Client({
    baseUrl: server.url,
    auth: { bearer: signJwt(JWT_SECRET) },
  }).sessions.attach(sessionId);
  const replies: string[] = [];
  const outcomes: string[] = [];
  for await (const event of session.stream({ signal: AbortSignal.timeout(120_000) })) {
    if (event.type === "content.completed" && event.data.kind === "text") {
      replies.push(String(event.data.value));
    }
    if (event.type === "turn.settled") {
      outcomes.push(event.data.outcome);
      if (outcomes.length === turns) break;
    }
  }
  return { outcomes, replies };
}

beforeAll(async () => {
  for (const name of Object.keys(process.env)) {
    if (isVercelEnvName(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("EVE_DEVELOPMENT_LINUX_DOCKER_AVAILABLE", "0");
  try {
    app = await materializeScenarioApp({
      name: "self-hosted-acceptance",
      installDependencies: true,
      files: {
        "agent/agent.ts": `import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  model: anthropic(process.env.ACCEPTANCE_MODEL ?? "claude-sonnet-5"),
});
`,
        "agent/instructions.md": "Answer Alice briefly. Do not use tools.\n",
        "agent/channels/eve.ts": `import { jwtHmac, localDev, placeholderAuth } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    jwtHmac({
      algorithm: "HS256",
      audiences: ["${JWT_AUDIENCE}"],
      issuer: "${JWT_ISSUER}",
      secret: process.env.ACCEPTANCE_JWT_SECRET ?? "",
    }),
    localDev(),
    placeholderAuth(),
  ],
});
`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: false });
  } finally {
    vi.unstubAllEnvs();
  }
}, 240_000);

afterAll(async () => {
  await app?.cleanup();
});

describe("self-hosted eve without Vercel", () => {
  it("builds a Node server and no Vercel output", () => {
    expect(existsSync(join(app.appRoot, ".output/server/index.mjs"))).toBe(true);
    expect(existsSync(join(app.appRoot, ".vercel"))).toBe(false);
  });

  it("starts, reports health, and enforces JWT HMAC route auth", async () => {
    const server = await startPackagedEveStart(app.appRoot, { env: selfHostedEnv() });
    try {
      const health = await fetch(new URL("/eve/v1/health", server.url));
      expect(health.status, server.stderr()).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, status: "ready" });
      await expect
        .poll(() => server.stdout(), { timeout: 15_000 })
        .toContain("sandbox: none. This build recorded no sandbox provider");

      const create = (authorization?: string) =>
        fetch(new URL("/eve/v1/session", server.url), {
          method: "POST",
          headers: authorization === undefined ? {} : { authorization },
        });
      const anonymous = await create();
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "eve_production_auth_not_configured" });
      expect(
        (await create(`Bearer ${signJwt("a-different-secret-0123456789abcdef")}`)).status,
      ).toBe(401);
      expect((await create(`Bearer ${signJwt(JWT_SECRET, { aud: "another-app" })}`)).status).toBe(
        401,
      );

      const accepted = await create(`Bearer ${signJwt(JWT_SECRET)}`);
      expect(accepted.status, server.stderr()).toBe(202);
      expect(await accepted.json()).toMatchObject({ ok: true, sessionId: expect.any(String) });
    } finally {
      await server.stop();
    }
    expect(existsSync(join(app.appRoot, ".vercel"))).toBe(false);
  }, 120_000);

  it.skipIf(ANTHROPIC_API_KEY === "")(
    "runs a real Anthropic turn and continues the session after a restart",
    async () => {
      const env = selfHostedEnv({ ANTHROPIC_API_KEY });
      let server = await startPackagedEveStart(app.appRoot, { env });
      let sessionId: string;
      try {
        const { session } = await new Client({
          baseUrl: server.url,
          auth: { bearer: signJwt(JWT_SECRET) },
        }).sessions.create();
        sessionId = session.id;
        await session.send("Alice's codeword is PELICAN-42. Reply with exactly: stored.");
        const first = await settledReplies(server, sessionId, 1);
        expect(first.outcomes, server.stderr()).toEqual(["completed"]);
      } finally {
        await server.crash();
      }

      server = await startPackagedEveStart(app.appRoot, { env });
      try {
        await new Client({ baseUrl: server.url, auth: { bearer: signJwt(JWT_SECRET) } }).sessions
          .attach(sessionId)
          .send("What is Alice's codeword? Reply with only the codeword.");
        const both = await settledReplies(server, sessionId, 2);
        expect(both.outcomes, server.stderr()).toEqual(["completed", "completed"]);
        expect(both.replies.at(-1)).toContain("PELICAN-42");
      } finally {
        await server.stop();
      }
    },
    300_000,
  );
});

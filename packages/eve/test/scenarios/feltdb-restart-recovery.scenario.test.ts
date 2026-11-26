import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startPackagedEveStart, withoutVercelEnv } from "./eve-start-harness.js";

const ALICE = { bearer: "meetings.org-a.alice" };
const BOB = { bearer: "meetings.org-a.bob" };
const CAROL = { bearer: "meetings.org-a.carol" };
const ALICE_IN_ANOTHER_APPLICATION = { bearer: "xeet.org-a.alice" };
const ALICE_IN_ANOTHER_ORGANIZATION = { bearer: "meetings.org-b.alice" };
const FELTDB_WORLD_ROOT = fileURLToPath(new URL("../../../eve-world-feltdb", import.meta.url));
const INTERRUPTED = "may or may not have taken effect";

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;
let root: string;

beforeAll(async () => {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  root = await mkdtemp(join(tmpdir(), "eve-feltdb-recovery-"));
  const packed = join(root, "packed");
  execFileSync("pnpm", ["--dir", FELTDB_WORLD_ROOT, "pack", "--pack-destination", packed], {
    stdio: "ignore",
  });
  const worldTarball = join(
    packed,
    readdirSync(packed).find((file) => file.endsWith(".tgz"))!,
  );
  try {
    app = await materializeScenarioApp({
      name: "feltdb-restart-recovery",
      installDependencies: true,
      dependencies: {
        "@appport/eve-world-feltdb": `file:${worldTarball}`,
        "@feltdb/core": "0.25.0",
      },
      files: {
        "agent/agent.ts": `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
const TOOLS = { payment: "record_payment", transfer: "start_transfer", refund: "issue_refund" } as const;
export default defineAgent({
  model: mockModel(async (request) => {
    const scratch = process.env.RECOVERY_SCRATCH!;
    const last = request.lastUserMessage ?? "";
    const tool = Object.entries(TOOLS).find(([word]) => last.includes(word))?.[1];
    if (tool === undefined) return "Heard: " + request.userMessages.join(" | ");
    const note = request.messages.find((message) => message.text?.includes("may or may not have taken effect"));
    if (note !== undefined) {
      writeFileSync(join(scratch, tool + ".saw"), note.text!);
      return "Done.";
    }
    if (request.toolResults.length === 0) return { toolCalls: [{ name: tool, input: { amount: 40 } }] };
    writeFileSync(join(scratch, tool + ".saw"), JSON.stringify(request.toolResults));
    if (tool === "record_payment") {
      while (!existsSync(join(scratch, "release"))) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return "Done.";
  }),
  modelContextWindowTokens: 32_000,
  experimental: { workflow: { world: "@appport/eve-world-feltdb" } },
});`,
        "agent/lib/effects.ts": `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function perform(effect: string): number {
  const file = join(process.env.RECOVERY_SCRATCH!, effect + ".count");
  let count = 0;
  try { count = Number(readFileSync(file, "utf8")); } catch {}
  writeFileSync(file, String(count + 1));
  return count + 1;
}`,
        "agent/tools/record_payment.ts": `import { defineTool } from "eve/tools";
import { perform } from "../lib/effects";
export default defineTool({
  description: "Record a payment with the payment provider.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
  async execute({ amount }: { amount: number }) {
    return { recorded: amount, receipt: "rcpt-" + perform("payments") };
  },
});`,
        "agent/tools/start_transfer.ts": `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { perform } from "../lib/effects";
export default defineTool({
  description: "Start a bank transfer. The bank answers when the transfer settles.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
  async execute({ amount }: { amount: number }) {
    const scratch = process.env.RECOVERY_SCRATCH!;
    perform("transfers");
    writeFileSync(join(scratch, "transfer-dispatched"), "");
    while (!existsSync(join(scratch, "bank-answers"))) await new Promise((resolve) => setTimeout(resolve, 50));
    return { transferred: amount };
  },
});`,
        "agent/tools/issue_refund.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { perform } from "../lib/effects";
export default defineTool({
  approval: always(),
  description: "Issue a refund. A person approves each one.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
  async execute({ amount }: { amount: number }) {
    return { refunded: amount, refund: perform("refunds") };
  },
});`,
        "agent/instructions.md": "Handle payments, transfers and refunds.\n",
        "agent/channels/eve.ts": `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBearerToken, none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({
  auth: [
    (request) => {
      const [application, organization, person] =
        extractBearerToken(request.headers.get("authorization"))?.split(".") ?? [];
      if (!application || !organization || !person) return null;
      return {
        attributes: {},
        authenticator: application,
        issuer: organization,
        principalId: person,
        principalType: "user",
      };
    },
    none(),
  ],
  sessionAccess: ({ caller, operation, owner, sessionId }) => {
    if (owner) return true;
    const grant = join(
      process.env.RECOVERY_SCRATCH!,
      "grants",
      sessionId,
      [caller.authenticator, caller.issuer, caller.principalId].join("."),
    );
    return existsSync(grant) && readFileSync(grant, "utf8").split(",").includes(operation);
  },
});`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });
  } finally {
    vi.unstubAllEnvs();
  }
}, 300_000);

afterAll(async () => {
  await app?.cleanup();
  await rm(root, { force: true, recursive: true });
});

async function scenarioDirectory(name: string) {
  const scratch = join(root, name);
  await rm(scratch, { force: true, recursive: true });
  const env = (extra: Record<string, string> = {}) =>
    withoutVercelEnv({
      EVE_FELTDB_PATH: join(scratch, "feltdb"),
      RECOVERY_SCRATCH: scratch,
      ...extra,
    });
  const start = (extra?: Record<string, string>) =>
    startPackagedEveStart(app.appRoot, { env: env(extra) });
  const count = (effect: string) => {
    const file = join(scratch, `${effect}.count`);
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  };
  const file = (name: string) => join(scratch, name);
  return { count, file, scratch, start };
}

async function settledOutcome(url: string, auth: typeof ALICE, sessionId: string) {
  const session = new Client({ baseUrl: url, auth }).sessions.attach(sessionId);
  for await (const event of session.stream({ signal: AbortSignal.timeout(90_000) })) {
    if (event.type === "turn.settled") return event.data.outcome;
  }
  return undefined;
}

function committedTurnSteps(scratch: string): number {
  const payloads = join(scratch, "feltdb", "payloads");
  if (!existsSync(payloads)) return 0;
  return readdirSync(payloads, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .filter((text) => text.includes('"eventType":"step_completed"') && text.includes("//turnStep"))
    .length;
}

async function grant(scratch: string, sessionId: string, delegate: string, operations: string) {
  await mkdir(join(scratch, "grants", sessionId), { recursive: true });
  await writeFile(join(scratch, "grants", sessionId, delegate), operations);
}

async function responseOutcome(url: string, sessionId: string) {
  const session = new Client({ baseUrl: url, auth: ALICE }).sessions.attach(sessionId, {
    streamIndex: 0,
  });
  for await (const event of session.stream({ signal: AbortSignal.timeout(60_000) })) {
    if (event.type === "response.settled") return event.data.outcome;
  }
  return undefined;
}

describe("eve on the FeltDB World, across the death of its host process", () => {
  it("continues with a completed effect's recorded outcome and does not run it again", async () => {
    const s = await scenarioDirectory("completed-effect");
    let server = await s.start();
    let sessionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      await session.send("Alice asks you to record her payment of 40.");
      sessionId = session.id;
      await expect
        .poll(() => existsSync(s.file("record_payment.saw")), { timeout: 60_000 })
        .toBe(true);
      expect((await attempt(server.url, ALICE.bearer, sessionId, "read")).body).toContain(
        '"type":"call.settled"',
      );
    } finally {
      await server.crash();
    }
    expect(s.count("payments")).toBe(1);

    await rm(s.file("record_payment.saw"));
    await writeFile(s.file("release"), "");
    server = await s.start();
    try {
      expect(await settledOutcome(server.url, ALICE, sessionId), server.stderr()).toBe("completed");
      expect(s.count("payments")).toBe(1);
      const seen = JSON.parse(await readFile(s.file("record_payment.saw"), "utf8"));
      expect(seen).toEqual([
        expect.objectContaining({
          name: "record_payment",
          output: { recorded: 40, receipt: "rcpt-1" },
        }),
      ]);
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("does not run an effect again whose start the dead host had not yet flushed, and says so", async () => {
    const s = await scenarioDirectory("interrupted-effect");
    let server = await s.start({ WORKFLOW_STREAM_FLUSH_INTERVAL_MS: "1500" });
    let sessionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      await session.send("Alice asks you to start the transfer of 40.");
      sessionId = session.id;
      await expect
        .poll(() => existsSync(s.file("transfer-dispatched")), { timeout: 60_000 })
        .toBe(true);
    } finally {
      await server.crash();
    }
    expect(s.count("transfers")).toBe(1);

    server = await s.start();
    try {
      expect(await settledOutcome(server.url, ALICE, sessionId), server.stderr()).toBe("completed");
      expect(s.count("transfers")).toBe(1);
      const seen = await readFile(s.file("start_transfer.saw"), "utf8");
      expect(seen).toContain(INTERRUPTED);
      const history: string[] = [];
      const session = new Client({ baseUrl: server.url, auth: ALICE }).sessions.attach(sessionId, {
        streamIndex: 0,
      });
      for await (const event of session.stream({ signal: AbortSignal.timeout(30_000) })) {
        history.push(JSON.stringify(event));
        if (event.type === "turn.settled") break;
      }
      expect(history.join("\n")).toContain("start_transfer");
    } finally {
      await writeFile(s.file("bank-answers"), "");
      await server.stop();
    }
  }, 300_000);

  it("keeps a session's history and its effects through repeated deaths of its host", async () => {
    const s = await scenarioDirectory("repeated-deaths");
    let server = await s.start();
    let sessionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      sessionId = session.id;
      await (await session.send("Alice says one.")).result();
    } finally {
      await server.crash();
    }

    server = await s.start({ WORKFLOW_STREAM_FLUSH_INTERVAL_MS: "1500" });
    try {
      await new Client({ baseUrl: server.url, auth: ALICE }).sessions
        .attach(sessionId)
        .send("Alice asks you to start the transfer of 40.");
      await expect
        .poll(() => existsSync(s.file("transfer-dispatched")), { timeout: 60_000 })
        .toBe(true);
    } finally {
      await server.crash();
    }

    for (const restart of [1, 2]) {
      server = await s.start();
      try {
        expect(await settledOutcome(server.url, ALICE, sessionId), `restart ${restart}`).toBe(
          "completed",
        );
        expect(s.count("transfers"), `restart ${restart}`).toBe(1);
      } finally {
        await server.crash();
      }
    }

    server = await s.start();
    try {
      const alice = new Client({ baseUrl: server.url, auth: ALICE }).sessions.attach(sessionId);
      const reply = (await (await alice.send("Alice says two.")).result()).reply ?? "";
      expect(reply.startsWith("Heard: Alice says one. | ")).toBe(true);
      expect(
        reply.endsWith(" | Alice asks you to start the transfer of 40. | Alice says two."),
      ).toBe(true);
      expect(await readFile(s.file("start_transfer.saw"), "utf8")).toContain(INTERRUPTED);
      expect(s.count("transfers")).toBe(1);
    } finally {
      await writeFile(s.file("bank-answers"), "");
      await server.stop();
    }
  }, 400_000);

  it("keeps a pending approval pending across the restart and runs it once when its requester approves", async () => {
    const s = await scenarioDirectory("pending-approval");
    let server = await s.start();
    let sessionId: string;
    let interactionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      const waiting = await (
        await session.send("Alice asks you to issue a refund of 40.")
      ).result();
      expect(waiting.status).toBe("awaiting-input");
      expect(waiting.interactions).toHaveLength(1);
      sessionId = session.id;
      interactionId = waiting.interactions[0]!.interactionId;
      await expect.poll(() => committedTurnSteps(s.scratch), { timeout: 30_000 }).toBe(1);
    } finally {
      await server.crash();
    }
    expect(s.count("refunds")).toBe(0);

    server = await s.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(s.count("refunds"), "nothing runs during recovery").toBe(0);

      await expect(
        new Client({ baseUrl: server.url, auth: BOB }).sessions
          .attach(sessionId)
          .respond([{ interactionId, optionId: "approve" }]),
        "someone without access to Alice's session cannot reach its approval",
      ).rejects.toThrow();

      await grant(s.scratch, sessionId, "meetings.org-a.carol", "respond");
      await new Client({ baseUrl: server.url, auth: CAROL }).sessions
        .attach(sessionId)
        .respond([{ interactionId, optionId: "approve" }]);
      expect(
        await responseOutcome(server.url, sessionId),
        "access to a session does not make Carol an approver of Alice's call",
      ).toBe("refused");
      expect(s.count("refunds")).toBe(0);

      const answered = await (
        await new Client({ baseUrl: server.url, auth: ALICE }).sessions
          .attach(sessionId)
          .respond([{ interactionId, optionId: "approve" }])
      ).result();
      expect(answered.status).toBe("completed");
      expect(s.count("refunds")).toBe(1);
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("restores two people's sessions independently, each with only its own history", async () => {
    const s = await scenarioDirectory("isolation");
    let server = await s.start();
    let aliceId: string;
    let bobId: string;
    try {
      const alice = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      const bob = await new Client({ baseUrl: server.url, auth: BOB }).sessions.create();
      await (await alice.session.send("Alice says one.")).result();
      await (await bob.session.send("Bob says two.")).result();
      aliceId = alice.session.id;
      bobId = bob.session.id;
    } finally {
      await server.crash();
    }

    server = await s.start();
    try {
      const alice = new Client({ baseUrl: server.url, auth: ALICE }).sessions.attach(aliceId);
      const bob = new Client({ baseUrl: server.url, auth: BOB }).sessions.attach(bobId);
      expect((await (await alice.send("Alice says three.")).result()).reply).toBe(
        "Heard: Alice says one. | Alice says three.",
      );
      expect((await (await bob.send("Bob says four.")).result()).reply).toBe(
        "Heard: Bob says two. | Bob says four.",
      );
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("refuses to start on state written in a format it cannot read, and leaves it untouched", async () => {
    const s = await scenarioDirectory("unreadable-state");
    let server = await s.start();
    let sessionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      await (await session.send("Alice says hello.")).result();
      sessionId = session.id;
    } finally {
      await server.stop();
    }
    const snapshot = join(s.scratch, "feltdb", "state", "state.json");
    const original = await readFile(snapshot, "utf8");
    const future = JSON.stringify({ ...JSON.parse(original), version: 99 });
    await writeFile(snapshot, future);

    const refused = await s.start().then(
      async (started) => {
        await started.stop();
        return "started";
      },
      (error: unknown) => String(error),
    );
    expect(refused).toContain("UNSUPPORTED_DURABLE_FORMAT");
    expect(await readFile(snapshot, "utf8")).toBe(future);

    await writeFile(snapshot, original);
    server = await s.start();
    try {
      const restored = new Client({ baseUrl: server.url, auth: ALICE }).sessions.attach(sessionId);
      expect((await (await restored.send("Alice says again.")).result()).reply).toBe(
        "Heard: Alice says hello. | Alice says again.",
      );
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("refuses to start without a FeltDB directory instead of keeping sessions anywhere else", async () => {
    const s = await scenarioDirectory("no-directory");
    const refused = await startPackagedEveStart(app.appRoot, {
      env: withoutVercelEnv({ RECOVERY_SCRATCH: s.scratch }),
    }).then(
      async (started) => {
        await started.stop();
        return "started";
      },
      (error: unknown) => String(error),
    );
    expect(refused).toContain("needs EVE_FELTDB_PATH");
  }, 300_000);

  it("gives a session to one host at a time: a second host is refused while the owner lives, even paused", async () => {
    const s = await scenarioDirectory("ownership");
    const owner = await s.start();
    try {
      const lock = JSON.parse(
        await readFile(join(s.scratch, "feltdb", "state", "owner.lock"), "utf8"),
      ) as { pid: number };
      const second = await s.start({ EVE_FELTDB_OWNER_WAIT_MS: "1000" }).then(
        async (started) => {
          await started.stop();
          return "started";
        },
        (error: unknown) => String(error),
      );
      expect(second).toContain("STATE_LOCKED");

      process.kill(lock.pid, "SIGSTOP");
      try {
        const whilePaused = await s.start({ EVE_FELTDB_OWNER_WAIT_MS: "1000" }).then(
          async (started) => {
            await started.stop();
            return "started";
          },
          (error: unknown) => String(error),
        );
        expect(whilePaused).toContain("STATE_LOCKED");
      } finally {
        process.kill(lock.pid, "SIGCONT");
      }
    } finally {
      await owner.stop();
    }
  }, 300_000);
});

const UNKNOWN_SESSION = "wrun_01M8ZZZZZZZZZZZZZZZZZZZZZZ";

async function attempt(
  url: string,
  token: string | undefined,
  sessionId: string,
  operation: "read" | "message" | "respond" | "control",
) {
  const path = new URL(`/eve/v1/session/${sessionId}`, url).href;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response =
    operation === "read"
      ? await fetch(`${path}/stream?startIndex=0&follow=false`, { headers })
      : await fetch(operation === "control" ? `${path}/cancel` : path, {
          body: JSON.stringify(
            operation === "message"
              ? { message: "Someone else writes into this session." }
              : operation === "respond"
                ? { answers: [{ interactionId: "req_A", optionId: "approve" }] }
                : {},
          ),
          headers,
          method: "POST",
        });
  return { body: await response.text(), status: response.status };
}

async function expectIndistinguishableFromUnknown(
  url: string,
  token: string | undefined,
  sessionId: string,
) {
  for (const operation of ["read", "message", "respond", "control"] as const) {
    expect(
      await attempt(url, token, sessionId, operation),
      `${token ?? "anonymous"} ${operation}`,
    ).toEqual(await attempt(url, token, UNKNOWN_SESSION, operation));
  }
}

const OUTSIDERS = [
  BOB.bearer,
  ALICE_IN_ANOTHER_APPLICATION.bearer,
  ALICE_IN_ANOTHER_ORGANIZATION.bearer,
  undefined,
];

describe("who may act on a session, before and after its host dies", () => {
  it("gives a session to the caller that created it and to explicit, revocable grants only", async () => {
    const s = await scenarioDirectory("session-access");
    let server = await s.start();
    let sessionId: string;
    let anonymousSessionId: string;
    try {
      const { session } = await new Client({ baseUrl: server.url, auth: ALICE }).sessions.create();
      sessionId = session.id;
      expect((await (await session.send("Alice says one.")).result()).reply).toBe(
        "Heard: Alice says one.",
      );
      const own = await attempt(server.url, ALICE.bearer, sessionId, "read");
      expect(own.status, own.body).toBe(200);
      expect(own.body).toContain("Alice says one.");

      for (const outsider of OUTSIDERS) {
        await expectIndistinguishableFromUnknown(server.url, outsider, sessionId);
      }

      await grant(s.scratch, sessionId, "meetings.org-a.carol", "read");
      const delegated = await attempt(server.url, CAROL.bearer, sessionId, "read");
      expect(delegated.status).toBe(200);
      expect(delegated.body).toContain("Alice says one.");
      expect(await attempt(server.url, CAROL.bearer, sessionId, "message")).toEqual(
        await attempt(server.url, CAROL.bearer, UNKNOWN_SESSION, "message"),
      );
      await rm(join(s.scratch, "grants", sessionId), { recursive: true });
      expect(await attempt(server.url, CAROL.bearer, sessionId, "read")).toEqual(
        await attempt(server.url, CAROL.bearer, UNKNOWN_SESSION, "read"),
      );

      const anonymous = await fetch(new URL("/eve/v1/session", server.url), {
        body: JSON.stringify({ message: "Someone without an identity says hello." }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(anonymous.status).toBe(202);
      anonymousSessionId = ((await anonymous.json()) as { sessionId: string }).sessionId;
      await expectIndistinguishableFromUnknown(server.url, undefined, anonymousSessionId);
    } finally {
      await server.crash();
    }

    server = await s.start();
    try {
      for (const outsider of OUTSIDERS) {
        await expectIndistinguishableFromUnknown(server.url, outsider, sessionId);
      }
      await expectIndistinguishableFromUnknown(server.url, undefined, anonymousSessionId);

      const alice = new Client({ baseUrl: server.url, auth: ALICE }).sessions.attach(sessionId);
      expect((await (await alice.send("Alice says two.")).result()).reply).toBe(
        "Heard: Alice says one. | Alice says two.",
      );

      await grant(s.scratch, sessionId, "meetings.org-a.carol", "read");
      expect((await attempt(server.url, CAROL.bearer, sessionId, "read")).body).toContain(
        "Alice says two.",
      );
      await rm(join(s.scratch, "grants", sessionId), { recursive: true });
      expect(await attempt(server.url, CAROL.bearer, sessionId, "read")).toEqual(
        await attempt(server.url, CAROL.bearer, UNKNOWN_SESSION, "read"),
      );
    } finally {
      await server.stop();
    }
  }, 300_000);
});

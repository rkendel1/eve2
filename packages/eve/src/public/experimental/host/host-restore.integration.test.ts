import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { sessionOwnerKey } from "#channel/session-owner.js";
import type { SessionAuthContext } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineAgent } from "#public/definitions/agent.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

import { createEveHost, type EveHost, type EveHostStore } from "./index.ts";

const INTERRUPTED = "may or may not have taken effect";

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "feltkit:meetings",
  issuer: "org-a",
  principalId: "alice",
  principalType: "user",
};

function durableStore(writeMs = 0) {
  const written = () => new Promise((resolve) => setTimeout(resolve, writeMs));
  const lines = new Map<string, string[]>();
  const sessions = new Map<string, string>();
  let generation = 0;
  const open = (): EveHostStore & { kill(): void } => {
    const mine = ++generation;
    const alive = () => {
      if (mine !== generation) throw new Error("this host is gone");
    };
    return {
      kill: () => void generation++,
      async appendLine(sessionId, index, line) {
        alive();
        const stream = lines.get(sessionId) ?? [];
        if (index !== stream.length) throw new Error(`line ${index} is not the next line`);
        lines.set(sessionId, [...stream, line]);
        if (writeMs > 0) await written();
      },
      async readLines(sessionId) {
        return [...(lines.get(sessionId) ?? [])];
      },
      async saveSession(sessionId, record) {
        alive();
        sessions.set(sessionId, record);
        if (writeMs > 0) await written();
      },
      async readSessions() {
        return [...sessions].map(([sessionId, record]) => ({ record, sessionId }));
      },
    };
  };
  return { lines, open, sessions };
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

const effects = { payments: 0, transfers: 0, refunds: 0 };
let transferBank = gate();
let paymentSeen = gate();
let paymentModel = gate();
const seen: string[][] = [];

function model() {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const asked = prompt.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        );
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [JSON.stringify(part.output)] : [],
              )
            : [],
        );
        seen.push([...asked, ...results]);
        const last = asked.filter((text) => !text.includes(INTERRUPTED)).at(-1) ?? "";
        const tool = last.includes("payment")
          ? "record_payment"
          : last.includes("transfer")
            ? "start_transfer"
            : last.includes("refund")
              ? "issue_refund"
              : undefined;
        if (tool === undefined) return textStreamResult(`Heard: ${asked.join(" | ")}`);
        if (asked.some((text) => text.includes(INTERRUPTED))) return textStreamResult("Noted.");
        if (results.length === 0) {
          return toolCallsStreamResult([
            { input: "{}", toolCallId: `call-${tool}`, toolName: tool },
          ]);
        }
        if (tool === "record_payment") {
          paymentSeen.release();
          await paymentModel.opened;
        }
        return textStreamResult(`Done: ${results.join(", ")}.`);
      },
      modelId: "host-restore",
      provider: "eve-test",
    }),
  );
}

const tool = (name: string, execute: () => Promise<unknown>, approval?: "always") => ({
  loadNamespace: async () => ({
    default: defineTool({
      ...(approval === "always" && { approval: always() }),
      description: `Run ${name}.`,
      execute,
      inputSchema: {},
    }),
  }),
  logicalPath: `tools/${name}.ts`,
});

async function withAgent(body: () => Promise<void>) {
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => {
          throw new Error("The host resolves the model.");
        }),
      }),
      name: "org-eve",
    },
    modules: [
      tool("record_payment", async () => ({ receipt: `rcpt-${++effects.payments}` })),
      tool("start_transfer", async () => {
        effects.transfers++;
        await transferBank.opened;
        return { transferred: true };
      }),
      tool("issue_refund", async () => ({ refund: ++effects.refunds }), "always"),
    ],
  });
  await test.run(body);
}

function host(store: EveHostStore): EveHost {
  return createEveHost({
    agent: readBundledCompiledArtifacts()!,
    models: { resolve: () => model() },
    store,
  });
}

async function gone(store: { kill(): void }, dead: EveHost) {
  store.kill();
  await dead.dispose().catch(() => {});
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe("eve/experimental/host with a store: sessions survive the host", () => {
  it("continues the same conversation, with its history, after the host is gone", async () => {
    await withAgent(async () => {
      const backing = durableStore();
      const first = backing.open();
      const before = host(first);
      const meeting = before.connect({ application: "meetings", conversation: "weekly-sync" });
      const one = await (await meeting.send("Alice says one.", { auth: ALICE })).result();
      expect(one.reply).toBe("Heard: Alice says one.");
      await before.idle();
      await gone(first, before);

      const after = host(backing.open());
      expect(await after.restoration).toEqual({ refused: [], restored: [one.sessionId] });
      expect(await after.runtime.readSessionOwnerKey!(one.sessionId)).toBe(sessionOwnerKey(ALICE));
      const again = after.connect({ application: "meetings", conversation: "weekly-sync" });
      const two = await (await again.send("Alice says two.", { auth: ALICE })).result();
      expect(two.sessionId).toBe(one.sessionId);
      expect(two.reply).toBe("Heard: Alice says one. | Alice says two.");

      const other = after.connect({ application: "incidents", conversation: "weekly-sync" });
      const elsewhere = await (await other.send("Bob says hello.", { auth: null })).result();
      expect(elsewhere.sessionId).not.toBe(one.sessionId);
      expect(elsewhere.reply).toBe("Heard: Bob says hello.");
      await after.dispose();
    });
  });

  it("keeps a pending approval across the host's death and runs the call once when it is answered", async () => {
    await withAgent(async () => {
      effects.refunds = 0;
      const backing = durableStore();
      const first = backing.open();
      const before = host(first);
      const asked = await (
        await before
          .connect({ application: "meetings", conversation: "refunds" })
          .send("Alice asks for a refund.", { auth: ALICE })
      ).result();
      expect(asked.status).toBe("awaiting-input");
      await before.idle();
      await gone(first, before);

      const after = host(backing.open());
      expect((await after.restoration).restored).toEqual([asked.sessionId]);
      expect(effects.refunds).toBe(0);
      const answered = await (
        await after.connect({ application: "meetings", conversation: "refunds" }).deliver(
          {
            answers: [{ interactionId: asked.interactions[0]!.interactionId, optionId: "approve" }],
          },
          { auth: ALICE },
        )
      ).result();
      expect(answered.status).toBe("completed");
      expect(effects.refunds).toBe(1);
      await after.dispose();
    });
  });

  it("restores a completed effect's recorded result when the host dies during the next model call", async () => {
    await withAgent(async () => {
      effects.payments = 0;
      paymentSeen = gate();
      paymentModel = gate();
      const backing = durableStore();
      const first = backing.open();
      const before = host(first);
      await before
        .connect({ application: "meetings", conversation: "payments" })
        .send("Alice asks you to record a payment.", { auth: ALICE });
      await paymentSeen.opened;
      await gone(first, before);
      expect(effects.payments).toBe(1);

      paymentModel.release();
      seen.length = 0;
      const after = host(backing.open());
      expect((await after.restoration).restored).toHaveLength(1);
      await after.idle();
      expect(effects.payments).toBe(1);
      expect(seen.flat().join("\n")).toContain("rcpt-1");
      await after.dispose();
    });
  });

  it.each([
    { store: "a store that writes at once", writeMs: 0 },
    { store: "a store whose writes take time", writeMs: 20 },
  ])(
    "does not run an effect again whose outcome the dead host never recorded, and tells the model, on $store",
    async ({ writeMs }) => {
      await withAgent(async () => {
        effects.transfers = 0;
        transferBank = gate();
        const backing = durableStore(writeMs);
        const first = backing.open();
        const before = host(first);
        await before
          .connect({ application: "meetings", conversation: "transfers" })
          .send("Alice asks you to start a transfer.", { auth: ALICE });
        await until(() => effects.transfers === 1);
        await gone(first, before);

        seen.length = 0;
        const after = host(backing.open());
        expect((await after.restoration).restored).toHaveLength(1);
        await after.idle();
        expect(effects.transfers).toBe(1);
        expect(seen.flat().join("\n")).toContain(INTERRUPTED);
        transferBank.release();
        await after.dispose();
      });
    },
  );

  it("refuses to restore a session whose checkpoint this eve cannot read, and leaves it as it was", async () => {
    await withAgent(async () => {
      const backing = durableStore();
      const first = backing.open();
      const before = host(first);
      const kept = await (
        await before
          .connect({ application: "meetings", conversation: "kept" })
          .send("Alice says one.", { auth: ALICE })
      ).result();
      const future = await (
        await before
          .connect({ application: "meetings", conversation: "future" })
          .send("Alice says one.", { auth: ALICE })
      ).result();
      await before.idle();
      await gone(first, before);
      const record = JSON.parse(backing.sessions.get(future.sessionId)!);
      record.checkpoint.version = 99;
      backing.sessions.set(future.sessionId, JSON.stringify(record));
      const untouched = backing.sessions.get(future.sessionId);

      const after = host(backing.open());
      const restoration = await after.restoration;
      expect(restoration.restored).toEqual([kept.sessionId]);
      expect(restoration.refused).toEqual([
        { reason: expect.stringContaining("99"), sessionId: future.sessionId },
      ]);
      expect(backing.sessions.get(future.sessionId)).toBe(untouched);
      await after.dispose();
    });
  });
});

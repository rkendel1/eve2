import { describe, expect, it, vi } from "vitest";

import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { inProcessDurableHost, type HostUnderTest } from "./host-under-test.js";
import { alice, ofType, probe, recorded, violations } from "./probe.js";

vi.setConfig({ testTimeout: 60_000 });

type StreamResult = ReturnType<typeof textStreamResult>;
type Respond = () => StreamResult | Promise<StreamResult>;

const HANG: Respond = () => new Promise<never>(() => {});
const TASK = "Summarize Bob's notes.";

function firstUserMessage(prompt: string): string {
  return JSON.stringify(
    (JSON.parse(prompt) as { role: string; content: unknown }[]).find(
      (message) => message.role === "user",
    )?.content ?? "",
  );
}

interface Script {
  child: Respond;
  parentAfterTool: Respond;
  readonly childCalls: string[];
}

function script(): Script {
  return {
    child: () => textStreamResult("Bob's notes say ship on Friday."),
    childCalls: [],
    parentAfterTool: () => textStreamResult("Alice, the helper is on it."),
  };
}

async function withParentAndChild(
  name: string,
  current: Script,
  body: (host: HostUnderTest, parentId: string) => Promise<void>,
): Promise<void> {
  const agent = await probe({
    name,
    respond: async (prompt) => {
      if (firstUserMessage(prompt).includes(TASK)) {
        current.childCalls.push(prompt);
        return await current.child();
      }
      if (prompt.includes('"role":"tool"')) return await current.parentAfterTool();
      return toolCallsStreamResult([
        { input: JSON.stringify({ message: TASK }), toolCallId: "call-agent", toolName: "agent" },
      ]);
    },
  });
  await agent.test.run(async () => {
    const host = await inProcessDurableHost.make();
    try {
      const sent = await alice(host.runtime, `${name}:alice`).send("Ask a helper.", { auth: null });
      await body(host, sent.sessionId);
    } finally {
      await host.dispose();
    }
  });
}

async function childOf(host: HostUnderTest, parentId: string): Promise<string> {
  let child: string | undefined;
  await vi.waitFor(
    async () => {
      const stored = await host.storedSessions!();
      child = stored.find(
        ({ ownerKey }) =>
          typeof ownerKey === "object" &&
          ownerKey !== null &&
          (ownerKey as { root?: unknown }).root === parentId,
      )?.sessionId;
      expect(child).toBeDefined();
    },
    { interval: 20, timeout: 10_000 },
  );
  return child!;
}

async function agentCallSettlements(
  host: HostUnderTest,
  parentId: string,
  count = 1,
): Promise<SessionStreamEvent[]> {
  await vi.waitFor(
    async () => {
      expect(ofType(await recorded(host.runtime, parentId), "call.settled")).toHaveLength(count);
    },
    { interval: 50, timeout: 20_000 },
  );
  await host.settled();
  return ofType(await recorded(host.runtime, parentId), "call.settled");
}

async function admittedTo(host: HostUnderTest, childId: string): Promise<number> {
  return ofType(await recorded(host.runtime, childId), "delivery.admitted").length;
}

describe("durable child sessions on the in-process host with a durable store", () => {
  it("re-attaches a running child after the process dies, and settles its call once across further restarts", async () => {
    const current = script();
    current.child = HANG;
    await withParentAndChild("reattach-running", current, async (host, parentId) => {
      const childId = await childOf(host, parentId);
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(1));
      current.child = () => textStreamResult("Bob's notes say ship on Friday.");
      await host.restart!();
      const [settled] = await agentCallSettlements(host, parentId);
      expect(settled).toMatchObject({ data: { callId: "call-agent", outcome: "completed" } });
      expect(JSON.stringify(settled)).toContain("Bob's notes say ship on Friday.");
      await host.restart!();
      await host.restart!();
      await host.settled();
      const events = await recorded(host.runtime, parentId);
      expect(ofType(events, "call.settled")).toHaveLength(1);
      expect(
        (await host.storedSessions!()).filter(
          ({ ownerKey }) => (ownerKey as { root?: unknown } | null)?.root === parentId,
        ),
      ).toHaveLength(1);
      expect(await admittedTo(host, childId)).toBe(1);
      expect(await violations(host.runtime, parentId)).toEqual([]);
    });
  });

  it("settles a reply the child finished before the parent applied it, after the process dies", async () => {
    const current = script();
    current.parentAfterTool = HANG;
    await withParentAndChild("reattach-finished", current, async (host, parentId) => {
      const childId = await childOf(host, parentId);
      await vi.waitFor(
        async () => {
          expect(ofType(await recorded(host.runtime, childId), "turn.settled")).toHaveLength(1);
        },
        { interval: 20, timeout: 10_000 },
      );
      expect(ofType(await recorded(host.runtime, parentId), "call.settled")).toHaveLength(0);
      await host.restart!();
      const [settled] = await agentCallSettlements(host, parentId);
      expect(settled).toMatchObject({ data: { callId: "call-agent", outcome: "completed" } });
      expect(JSON.stringify(settled)).toContain("Bob's notes say ship on Friday.");
      expect(current.childCalls).toHaveLength(1);
      expect(await admittedTo(host, childId)).toBe(1);
    });
  });

  it("settles once when recovery itself is interrupted by another restart", async () => {
    const current = script();
    current.child = HANG;
    await withParentAndChild("reattach-twice", current, async (host, parentId) => {
      const childId = await childOf(host, parentId);
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(1));
      await host.restart!();
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(2));
      current.child = () => textStreamResult("Bob's notes say ship on Friday.");
      await host.restart!();
      const settled = await agentCallSettlements(host, parentId);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ data: { outcome: "completed" } });
      expect(await admittedTo(host, childId)).toBe(1);
    });
  });

  it("settles the call as failed when the re-attached child's turn fails", async () => {
    const current = script();
    current.child = HANG;
    await withParentAndChild("reattach-failed", current, async (host, parentId) => {
      await childOf(host, parentId);
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(1));
      current.child = () => {
        throw new Error("Bob's notes are unreadable.");
      };
      await host.restart!();
      const [settled] = await agentCallSettlements(host, parentId);
      expect(settled).toMatchObject({ data: { callId: "call-agent", outcome: "failed" } });
      expect(JSON.stringify(settled)).toContain("The agent's turn failed");
    });
  });

  it("cancels the re-attached child's turn when the parent is cancelled, and settles the call as interrupted", async () => {
    const current = script();
    current.child = HANG;
    await withParentAndChild("reattach-cancelled", current, async (host, parentId) => {
      const childId = await childOf(host, parentId);
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(1));
      await host.restart!();
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(2));
      await host.runtime.dispatchSession({
        command: { deliveryId: "alice-cancels", kind: "cancel" },
        sessionId: parentId,
      });
      const [settled] = await agentCallSettlements(host, parentId);
      expect(settled).toMatchObject({ data: { callId: "call-agent", outcome: "interrupted" } });
      await vi.waitFor(
        async () => {
          expect(ofType(await recorded(host.runtime, childId), "turn.settled")).toMatchObject([
            { data: { outcome: "cancelled" } },
          ]);
        },
        { interval: 50, timeout: 10_000 },
      );
      expect(current.childCalls).toHaveLength(2);
    });
  });

  it("fails the call explicitly when no record links the task to a child, and starts no new child", async () => {
    const current = script();
    current.child = HANG;
    await withParentAndChild("reattach-unlinked", current, async (host, parentId) => {
      const childId = await childOf(host, parentId);
      await vi.waitFor(() => expect(current.childCalls).toHaveLength(1));
      await host.restart!({ beforeStart: async () => host.forgetSession!(childId) });
      const [settled] = await agentCallSettlements(host, parentId);
      expect(settled).toMatchObject({ data: { callId: "call-agent", outcome: "failed" } });
      expect(JSON.stringify(settled)).toContain("could not confirm whether the agent received it");
      expect(current.childCalls).toHaveLength(1);
      expect(
        (await host.storedSessions!()).filter(
          ({ ownerKey }) => (ownerKey as { root?: unknown } | null)?.root === parentId,
        ),
      ).toHaveLength(0);
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { inProcessDurableHost, type HostUnderTest } from "./host-under-test.js";
import { alice, ofType, probe, recorded, violations } from "./probe.js";

vi.setConfig({ testTimeout: 60_000 });

type StreamResult = ReturnType<typeof textStreamResult>;
type Respond = () => StreamResult | Promise<StreamResult>;

const HANG: Respond = () => new Promise<never>(() => {});
const WORKING = "Alice, the helpers are on it.";
const FINAL = "Alice, the helpers replied.";

interface Helper {
  readonly callId: string;
  readonly task: string;
  readonly answer: string;
  reply: Respond;
  readonly calls: string[];
}

interface Scenario {
  readonly helpers: readonly Helper[];
  holdWorking: number;
  holdFinal: number;
  readonly parentCalls: string[];
}

function helper(callId: string, task: string, answer: string): Helper {
  return { answer, callId, calls: [], reply: () => textStreamResult(answer), task };
}

const bob = () => helper("call-bob", "Summarize Bob's notes.", "Bob ships Friday.");
const carol = () => helper("call-carol", "Summarize Carol's notes.", "Carol ships Monday.");

function scenario(...helpers: Helper[]): Scenario {
  return {
    helpers: helpers.length > 0 ? helpers : [bob()],
    holdFinal: 0,
    holdWorking: 0,
    parentCalls: [],
  };
}

function gate(): { readonly open: () => void; readonly reply: (answer: string) => Respond } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    open,
    reply: (answer) => async () => {
      await opened;
      return textStreamResult(answer);
    },
  };
}

async function withParent(
  name: string,
  current: Scenario,
  body: (host: HostUnderTest, parentId: string) => Promise<void>,
): Promise<void> {
  const agent = await probe({
    name,
    respond: async (prompt) => {
      const messages = JSON.parse(prompt) as { role: string; content: unknown }[];
      const first = JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
      const child = current.helpers.find((h) => first.includes(h.task));
      if (child !== undefined) {
        child.calls.push(prompt);
        return await child.reply();
      }
      current.parentCalls.push(prompt);
      if (!messages.some((m) => m.role === "tool")) {
        return toolCallsStreamResult(
          current.helpers.map((h) => ({
            input: JSON.stringify({ message: h.task }),
            toolCallId: h.callId,
            toolName: "agent",
          })),
        );
      }
      const final = current.helpers.every((h) => tasksSettledIn(prompt, h));
      if (final ? current.holdFinal-- > 0 : current.holdWorking-- > 0) return await HANG();
      return textStreamResult(final ? FINAL : WORKING);
    },
  });
  await agent.test.run(async () => {
    const host = await inProcessDurableHost.make();
    try {
      const sent = await alice(host.runtime, `${name}:alice`).send("Ask the helpers.", {
        auth: null,
      });
      await body(host, sent.sessionId);
    } finally {
      await host.dispose();
    }
  });
}

function tasksSettledIn(prompt: string, h: Helper): boolean {
  return prompt.includes(h.answer) || prompt.includes("The agent's turn failed");
}

async function parentStep(current: Scenario, kind: "working" | "final"): Promise<void> {
  await vi.waitFor(
    () => {
      const steps = current.parentCalls.filter((prompt) => prompt.includes('"role":"tool"'));
      const final = steps.filter((prompt) =>
        current.helpers.every((h) => tasksSettledIn(prompt, h)),
      );
      expect(kind === "final" ? final.length : steps.length - final.length).toBeGreaterThan(0);
    },
    { interval: 20, timeout: 10_000 },
  );
}

async function settledTurn(host: HostUnderTest, parentId: string): Promise<SessionStreamEvent[]> {
  await vi.waitFor(
    async () => {
      expect(ofType(await recorded(host.runtime, parentId), "turn.settled")).toHaveLength(1);
    },
    { interval: 50, timeout: 20_000 },
  );
  await host.settled();
  return await recorded(host.runtime, parentId);
}

async function children(host: HostUnderTest, parentId: string): Promise<string[]> {
  return (await host.storedSessions!())
    .filter(({ ownerKey }) => (ownerKey as { root?: unknown } | null)?.root === parentId)
    .map(({ sessionId }) => sessionId);
}

async function expectNoDuplicateWork(host: HostUnderTest, parentId: string, current: Scenario) {
  const events = await recorded(host.runtime, parentId);
  expect(ofType(events, "turn.started")).toHaveLength(1);
  expect(ofType(events, "task.started")).toHaveLength(current.helpers.length);
  for (const { callId } of current.helpers) {
    expect(ofType(events, "call.requested").filter((e) => e.data.callId === callId)).toHaveLength(
      1,
    );
    expect(ofType(events, "call.started").filter((e) => e.data.callId === callId)).toHaveLength(1);
    expect(ofType(events, "call.settled").filter((e) => e.data.callId === callId)).toHaveLength(1);
  }
  const kids = await children(host, parentId);
  expect(kids).toHaveLength(current.helpers.length);
  for (const kid of kids) {
    expect(ofType(await recorded(host.runtime, kid), "delivery.admitted")).toHaveLength(1);
  }
  expect(await violations(host.runtime, parentId)).toEqual([]);
}

function finalReply(events: readonly SessionStreamEvent[]): string {
  const [settled] = ofType(events, "turn.settled");
  const parts = new Set((settled?.data as { reply?: string[] } | undefined)?.reply ?? []);
  return ofType(events, "content.completed")
    .filter((e) => e.data.phase === "reply" && parts.has(String(e.data.partId)))
    .map((e) => String(e.data.value))
    .join("");
}

async function expectCompleted(host: HostUnderTest, parentId: string, current: Scenario) {
  const events = await settledTurn(host, parentId);
  expect(ofType(events, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
  expect(finalReply(events)).toBe(FINAL);
  await expectNoDuplicateWork(host, parentId, current);
  return events;
}

describe("an interrupted parent turn on the in-process host with a durable store", () => {
  it("resumes its continuation step after the process dies while its child works, without redispatching", async () => {
    const current = scenario();
    const [child] = current.helpers;
    child!.reply = HANG;
    current.holdWorking = 1;
    await withParent("parent-running-child", current, async (host, parentId) => {
      await vi.waitFor(() => expect(child!.calls).toHaveLength(1));
      await parentStep(current, "working");
      child!.reply = () => textStreamResult(child!.answer);
      await host.restart!();
      await expectCompleted(host, parentId, current);
      expect(current.parentCalls.at(-1)).toContain(child!.answer);
    });
  });

  it("keeps the restored turn open while the re-attached child still works, then finishes it", async () => {
    const current = scenario();
    const [child] = current.helpers;
    const release = gate();
    child!.reply = HANG;
    await withParent("parent-child-still-running", current, async (host, parentId) => {
      await vi.waitFor(() => expect(child!.calls).toHaveLength(1));
      await vi.waitFor(async () => {
        const events = await recorded(host.runtime, parentId);
        expect(ofType(events, "content.completed").map((e) => e.data.value)).toContain(WORKING);
      });
      child!.reply = release.reply(child!.answer);
      await host.restart!();
      await vi.waitFor(() => expect(child!.calls).toHaveLength(2));
      const before = current.parentCalls.length;
      expect(ofType(await recorded(host.runtime, parentId), "turn.settled")).toHaveLength(0);
      release.open();
      const events = await expectCompleted(host, parentId, current);
      expect(current.parentCalls.length).toBeGreaterThan(before);
      expect(
        ofType(events, "content.completed").filter((e) => e.data.value === WORKING),
      ).toHaveLength(1);
    });
  });

  it("finishes the turn with a reply the child completed before the parent recovered", async () => {
    const current = scenario();
    const [child] = current.helpers;
    current.holdWorking = 1;
    await withParent("parent-child-finished", current, async (host, parentId) => {
      await parentStep(current, "working");
      const [kid] = await children(host, parentId);
      await vi.waitFor(
        async () => {
          expect(ofType(await recorded(host.runtime, kid!), "turn.settled")).toHaveLength(1);
        },
        { interval: 20, timeout: 10_000 },
      );
      await host.restart!();
      await expectCompleted(host, parentId, current);
      expect(current.parentCalls.at(-1)).toContain(child!.answer);
      expect(child!.calls).toHaveLength(1);
    });
  });

  it("finishes the turn when the process dies after the child's reply was applied", async () => {
    const current = scenario();
    current.holdFinal = 1;
    await withParent("parent-after-settlement", current, async (host, parentId) => {
      await parentStep(current, "final");
      expect(ofType(await recorded(host.runtime, parentId), "call.settled")).toHaveLength(1);
      await host.restart!();
      const events = await expectCompleted(host, parentId, current);
      expect(
        ofType(events, "content.completed").filter((e) => e.data.value === FINAL),
      ).toHaveLength(1);
    });
  });

  it("converges across repeated restarts and never reopens the completed turn", async () => {
    const current = scenario();
    const [child] = current.helpers;
    child!.reply = HANG;
    current.holdWorking = 1;
    current.holdFinal = 1;
    await withParent("parent-many-restarts", current, async (host, parentId) => {
      await parentStep(current, "working");
      await host.restart!();
      await host.restart!();
      child!.reply = () => textStreamResult(child!.answer);
      await host.restart!();
      await parentStep(current, "final");
      await host.restart!();
      await expectCompleted(host, parentId, current);
      const calls = current.parentCalls.length;
      await host.restart!();
      await host.restart!();
      await host.settled();
      const events = await recorded(host.runtime, parentId);
      expect(ofType(events, "turn.settled")).toHaveLength(1);
      expect(current.parentCalls).toHaveLength(calls);
      await expectNoDuplicateWork(host, parentId, current);
    });
  });

  it("resumes a step that started several children, and settles each once", async () => {
    const current = scenario(bob(), carol());
    for (const h of current.helpers) h.reply = HANG;
    current.holdWorking = 1;
    await withParent("parent-two-children", current, async (host, parentId) => {
      await vi.waitFor(() => {
        for (const h of current.helpers) expect(h.calls).toHaveLength(1);
      });
      await parentStep(current, "working");
      for (const h of current.helpers) h.reply = () => textStreamResult(h.answer);
      await host.restart!();
      await expectCompleted(host, parentId, current);
      for (const h of current.helpers) expect(current.parentCalls.at(-1)).toContain(h.answer);
    });
  });

  it("finishes the turn with one child failed and one completed", async () => {
    const [failing, succeeding] = [bob(), carol()];
    const current = scenario(failing, succeeding);
    failing.reply = HANG;
    succeeding.reply = HANG;
    current.holdWorking = 1;
    await withParent("parent-mixed-outcomes", current, async (host, parentId) => {
      await parentStep(current, "working");
      failing.reply = () => {
        throw new Error("Bob's notes are unreadable.");
      };
      succeeding.reply = () => textStreamResult(succeeding.answer);
      await host.restart!();
      const events = await expectCompleted(host, parentId, current);
      const outcomes = Object.fromEntries(
        ofType(events, "call.settled").map((e) => [e.data.callId, e.data.outcome]),
      );
      expect(outcomes).toEqual({ "call-bob": "failed", "call-carol": "completed" });
      expect(current.parentCalls.at(-1)).toContain(succeeding.answer);
    });
  });

  it("cancels the restored turn and its re-attached child when Alice cancels", async () => {
    const current = scenario();
    const [child] = current.helpers;
    child!.reply = HANG;
    await withParent("parent-cancelled", current, async (host, parentId) => {
      await parentStep(current, "working");
      await host.restart!();
      await vi.waitFor(() => expect(child!.calls).toHaveLength(2));
      const calls = current.parentCalls.length;
      await host.runtime.dispatchSession({
        command: { deliveryId: "alice-cancels", kind: "cancel" },
        sessionId: parentId,
      });
      const events = await settledTurn(host, parentId);
      expect(ofType(events, "turn.settled")).toMatchObject([{ data: { outcome: "cancelled" } }]);
      expect(ofType(events, "call.settled")).toMatchObject([
        { data: { callId: "call-bob", outcome: "interrupted" } },
      ]);
      const [kid] = await children(host, parentId);
      await vi.waitFor(
        async () => {
          expect(ofType(await recorded(host.runtime, kid!), "turn.settled")).toMatchObject([
            { data: { outcome: "cancelled" } },
          ]);
        },
        { interval: 50, timeout: 10_000 },
      );
      expect(current.parentCalls).toHaveLength(calls);
      expect(child!.calls).toHaveLength(2);
    });
  });

  it("refuses to restore a parent whose stored continuation is unreadable, and runs none of its work", async () => {
    const current = scenario();
    const [child] = current.helpers;
    child!.reply = HANG;
    current.holdWorking = 1;
    await withParent("parent-corrupt-continuation", current, async (host, parentId) => {
      await parentStep(current, "working");
      const calls = current.parentCalls.length;
      const restoration = await host.restart!({
        beforeStart: async () =>
          host.rewriteSession!(parentId, (session) => ({
            ...session,
            openTurn: {
              ...session.openTurn,
              step: { runtimeResults: { results: "lost" } } as never,
            },
          })),
      });
      expect(restoration).toMatchObject({
        refused: [
          {
            reason: expect.stringContaining("its stored continuation is not one eve can read"),
            sessionId: parentId,
          },
        ],
      });
      expect(restoration?.restored).not.toContain(parentId);
      await vi.waitFor(() => expect(child!.calls).toHaveLength(2));
      expect(current.parentCalls).toHaveLength(calls);
      expect(await children(host, parentId)).toHaveLength(1);
    });
  });
});

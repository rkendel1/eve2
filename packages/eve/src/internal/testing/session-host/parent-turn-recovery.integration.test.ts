import { describe, expect, it, vi } from "vitest";

import {
  textStreamResult,
  toolCallStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import {
  waitingForCleanupBody,
  waitingForCleanupWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  inProcessDurableHost,
  type CrashPoint,
  type HostUnderTest,
  type StoreWrite,
} from "./host-under-test.js";
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
  arm?: (host: HostUnderTest) => void,
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
      arm?.(host);
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
  const count = (type: "call.requested" | "call.started" | "call.settled", callId: string) =>
    ofType(events, type).filter((e) => e.data.callId === callId).length;
  for (const requested of ofType(events, "call.requested")) {
    const { callId } = requested.data;
    expect(count("call.requested", callId)).toBe(1);
    expect(count("call.started", callId)).toBeLessThanOrEqual(1);
    expect(count("call.settled", callId)).toBe(1);
  }
  const started = ofType(events, "task.started");
  expect(started).toHaveLength(current.helpers.length);
  const settledOutputs = ofType(events, "call.settled").map((e) => JSON.stringify(e.data));
  for (const h of current.helpers) {
    expect(settledOutputs.filter((data) => data.includes(h.answer)).length).toBeLessThanOrEqual(1);
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

  it("refuses a parent whose stored continuation is unreadable, and leaves its child stored and unrun", async () => {
    const current = scenario();
    const [child] = current.helpers;
    child!.reply = HANG;
    current.holdWorking = 1;
    await withParent("parent-corrupt-continuation", current, async (host, parentId) => {
      await parentStep(current, "working");
      const [kid] = await children(host, parentId);
      const calls = current.parentCalls.length;
      const rewrite = async () =>
        host.rewriteSession!(parentId, (session) => ({
          ...session,
          openTurn: { ...session.openTurn, step: { runtimeResults: { results: "lost" } } as never },
        }));
      for (let attempt = 0; attempt < 2; attempt++) {
        const restoration = await host.restart!({
          beforeStart: attempt === 0 ? rewrite : undefined,
        });
        expect(restoration?.restored).toEqual([]);
        expect(restoration?.refused).toEqual(
          expect.arrayContaining([
            {
              reason: expect.stringContaining("its stored continuation is not one eve can read"),
              sessionId: parentId,
            },
            {
              reason: expect.stringContaining(
                `its parent session ${parentId} could not be restored`,
              ),
              sessionId: kid,
            },
          ]),
        );
        await host.settled();
      }
      expect(current.parentCalls).toHaveLength(calls);
      expect(child!.calls).toHaveLength(1);
      expect(await children(host, parentId)).toEqual([kid]);
    });
  });
});

type StoredRecord = Record<string, unknown> & {
  readonly openTurn?: {
    readonly waiting?: { readonly on?: string; readonly dispatch?: boolean };
    readonly dispatched?: unknown;
  };
  readonly launches?: readonly { readonly child?: string }[];
  readonly checkpoint?: unknown;
};

const parentRecord =
  (match: (record: StoredRecord) => boolean) =>
  (write: StoreWrite): boolean =>
    write.kind === "session" && !write.child && match(write.record as StoredRecord);

const childRecord =
  (match: (record: StoredRecord) => boolean) =>
  (write: StoreWrite): boolean =>
    write.kind === "session" && write.child && match(write.record as StoredRecord);

const factLine =
  (child: boolean, type: string) =>
  (write: StoreWrite): boolean =>
    write.kind === "line" &&
    write.child === child &&
    Array.isArray(write.line.facts) &&
    (write.line.facts as { type?: unknown }[]).some((fact) => fact.type === type);

const intent = (record: StoredRecord) =>
  record.openTurn?.waiting?.on === "calls" && record.openTurn.waiting.dispatch === true;

interface Boundary {
  readonly name: string;
  readonly point: CrashPoint;
  readonly crashes?: number;
  readonly helpers?: () => Helper[];
}

const BOUNDARIES: readonly Boundary[] = [
  {
    name: "before the dispatch intent is durable",
    point: { at: parentRecord(intent), landed: false },
  },
  {
    name: "after the dispatch intent, before any child exists",
    point: { at: parentRecord(intent), landed: true },
    crashes: 2,
  },
  {
    name: "after the dispatch results and launches are durable, before the run starts",
    point: {
      at: parentRecord((record) => record.openTurn?.dispatched !== undefined),
      landed: true,
    },
  },
  {
    name: "after the child exists, before the parent acknowledges it",
    point: { at: childRecord((record) => record.checkpoint !== undefined), landed: true },
  },
  {
    name: "after the child admitted its delivery, before the acknowledgement lands",
    point: {
      at: parentRecord((record) => record.launches?.some((launch) => launch.child) === true),
      landed: false,
    },
  },
  {
    name: "after the child was told, before the parent records child.sent",
    point: { at: factLine(false, "child.sent"), landed: false },
  },
  {
    name: "while the child's model call runs",
    point: { at: factLine(true, "model.requested"), landed: true },
    crashes: 2,
  },
  {
    name: "after the child completed, before the parent settles the call",
    point: { at: factLine(false, "call.settled"), landed: false },
    crashes: 2,
  },
  {
    name: "after the parent settled the call, before its continuation is durable",
    point: { at: factLine(false, "call.settled"), landed: true },
  },
  {
    name: "between starting two children",
    point: { at: childRecord((record) => record.checkpoint !== undefined), landed: true },
    helpers: () => [bob(), carol()],
  },
];

describe("process death at each durable boundary of a parent's child dispatch", () => {
  for (const boundary of BOUNDARIES) {
    it(`recovers exactly once when the process dies ${boundary.name}`, async () => {
      const current = scenario(...(boundary.helpers?.() ?? []));
      let crashed: Promise<void> | undefined;
      await withParent(
        `crash-${boundary.name.replace(/[^a-z]+/g, "-")}`,
        current,
        async (host, parentId) => {
          for (let crash = 1; crash <= (boundary.crashes ?? 1); crash++) {
            await crashed;
            crashed = crash < (boundary.crashes ?? 1) ? host.crashAt!(boundary.point) : undefined;
            await host.restart!();
          }
          await expectCompleted(host, parentId, current);
          for (const h of current.helpers) expect(current.parentCalls.at(-1)).toContain(h.answer);
          let abandoned = 0;
          const kids = await children(host, parentId);
          for (const kid of kids) {
            const events = await recorded(host.runtime, kid);
            expect(ofType(events, "turn.settled")).toMatchObject([
              { data: { outcome: "completed" } },
            ]);
            expect(
              ofType(events, "content.completed").filter((e) => e.data.phase === "reply"),
            ).toHaveLength(1);
            abandoned += ofType(events, "model.settled").filter(
              (e) => e.data.outcome === "abandoned",
            ).length;
          }
          const childModelCalls = current.helpers.reduce((sum, h) => sum + h.calls.length, 0);
          expect(childModelCalls).toBeGreaterThanOrEqual(kids.length);
          expect(childModelCalls).toBeLessThanOrEqual(kids.length + abandoned);
          const settled = current.parentCalls.length;
          await host.restart!();
          await host.settled();
          expect(current.parentCalls).toHaveLength(settled);
          await expectNoDuplicateWork(host, parentId, current);
        },
        (host) => {
          crashed = host.crashAt!(boundary.point);
        },
      );
    });
  }
});

describe("a task whose authored run dies with the process", () => {
  it("ends with an explicit unknown outcome, is not run again, and the turn finishes", async () => {
    const agent = await probe({
      name: "parent-lost-workflow-task",
      respond: (prompt) => {
        if (prompt.includes("outcome is unknown")) return textStreamResult(FINAL);
        if (prompt.includes('"role":"tool"')) return textStreamResult(WORKING);
        return toolCallStreamResult({
          input: JSON.stringify({ service: "api" }),
          toolCallId: "call-cleanup",
          toolName: "cleanup",
        });
      },
      tools: [{ name: "cleanup", task: true, workflow: waitingForCleanupWorkflow }],
    });
    await agent.test.run(async () => {
      const host = await inProcessDurableHost.make({ workflows: [waitingForCleanupBody()] });
      try {
        const crashed = host.crashAt!({ at: factLine(false, "call.started"), landed: true });
        const sent = await alice(host.runtime, "lost-task:alice").send("Clean up the api.", {
          auth: null,
        });
        await crashed;
        expect(await host.workflowRunsStarted()).toBeLessThanOrEqual(1);
        const started = await host.workflowRunsStarted();
        await host.restart!();
        const events = await settledTurn(host, sent.sessionId);
        expect(ofType(events, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
        expect(finalReply(events)).toBe(FINAL);
        const settled = ofType(events, "call.settled").filter(
          (e) => e.data.callId === "call-cleanup",
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ data: { outcome: "failed" } });
        expect(JSON.stringify(settled[0])).toContain("outcome is unknown");
        expect(await host.workflowRunsStarted()).toBe(started);
        expect(await violations(host.runtime, sent.sessionId)).toEqual([]);
      } finally {
        await host.dispose();
      }
    });
  });
});

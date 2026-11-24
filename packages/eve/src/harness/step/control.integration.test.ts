import { describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import {
  workflowHost,
  type HostUnderTest,
} from "#internal/testing/session-host/host-under-test.js";
import {
  alice,
  ofType,
  probe,
  recorded,
  turnFrom,
  violations,
  type Probe,
  type ProbeOptions,
} from "#internal/testing/session-host/probe.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type {
  AgentControl,
  AgentControlBoundary,
  AgentControlCheckpoint,
} from "#shared/agent-definition.js";

vi.setConfig({ testTimeout: 60_000 });

type Decide = (input: {
  readonly boundary: AgentControlBoundary;
  readonly call: number;
}) => AgentControlCheckpoint;

interface Host {
  readonly asked: { readonly boundary: AgentControlBoundary; readonly turnId: string }[];
  readonly acknowledged: { readonly instructionId: string; readonly note: string }[];
  decide(next: Decide): void;
  readonly control: AgentControl;
}

const PROCEED: AgentControlCheckpoint = { instructions: [], proceed: true };
const PAUSED: AgentControlCheckpoint = { instructions: [], proceed: false, reason: "Bob paused" };

function hostControl(initial: Decide): Host {
  let decide = initial;
  const asked: Host["asked"] = [];
  const acknowledged: Host["acknowledged"] = [];
  return {
    acknowledged,
    asked,
    control: {
      async acknowledge({ instructionId, note }) {
        acknowledged.push({ instructionId, note });
      },
      async checkpoint({ boundary, turnId }) {
        asked.push({ boundary, turnId });
        return decide({ boundary, call: asked.length });
      },
    },
    decide(next) {
      decide = next;
    },
  };
}

async function withControlledAgent(
  options: Omit<ProbeOptions, "control"> & { readonly host: Host },
  body: (host: HostUnderTest, agent: Probe) => Promise<void>,
): Promise<Probe> {
  const agent = await probe({ ...options, control: options.host.control });
  await agent.test.run(async () => {
    const host = await workflowHost.make();
    try {
      await body(host, agent);
    } finally {
      await host.dispose();
    }
  });
  return agent;
}

async function eventually(
  runtime: Runtime,
  sessionId: string,
  matches: (events: readonly SessionStreamEvent[]) => boolean,
): Promise<SessionStreamEvent[]> {
  let events: SessionStreamEvent[] = [];
  await vi.waitFor(
    async () => {
      events = await recorded(runtime, sessionId);
      expect(matches(events)).toBe(true);
    },
    { interval: 25, timeout: 20_000 },
  );
  return events;
}

async function untilEnded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (
    await runtime.getEventStream(sessionId, { signal: AbortSignal.timeout(30_000), startIndex: 0 })
  ).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      events.push(next.value);
      if (next.value.type === "session.ended") break;
    }
    return events;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const held = (boundary: AgentControlBoundary) => (events: readonly SessionStreamEvent[]) =>
  ofType(events, "turn.held").some((event) => event.data.boundary === boundary);

async function command(
  runtime: Runtime,
  sessionId: string,
  kind: "cancel" | "reset" | "resume",
  deliveryId: string,
): Promise<void> {
  await runtime.dispatchSession({ command: { deliveryId, kind }, sessionId });
}

function settledControls(events: readonly SessionStreamEvent[], deliveryIds: readonly string[]) {
  return ofType(events, "delivery.settled")
    .filter((event) => deliveryIds.includes(event.data.deliveryId))
    .map((event) => [event.data.deliveryId, event.data.outcome]);
}

const reply = (text: string) => () => textStreamResult(text);

const lookupThenReply = (prompt: string) =>
  prompt.includes('"role":"tool"')
    ? textStreamResult("Alice, the lookup is done.")
    : toolCallStreamResult({ input: "{}", toolCallId: "call-lookup", toolName: "lookup" });

describe("agent control", () => {
  it("runs as before when the control lets every step proceed", async () => {
    const host = hostControl(() => PROCEED);
    const agent = await withControlledAgent(
      { host, name: "control-proceed", respond: lookupThenReply, tools: [{ name: "lookup" }] },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:proceed").send("Alice asks for a lookup.", {
          auth: null,
        });
        expect(await sent.result()).toMatchObject({ status: "completed" });
        const events = await recorded(runtime, sent.sessionId);
        expect(ofType(events, "turn.held")).toEqual([]);
        expect(await violations(runtime, sent.sessionId)).toEqual([]);
      },
    );
    expect(agent.ran).toEqual(["lookup"]);
    expect(host.asked.map(({ boundary }) => boundary)).toEqual(["model", "tools", "model"]);
  });

  it("holds before a model step until resume, then runs the step once", async () => {
    const host = hostControl(() => PAUSED);
    const agent = await withControlledAgent(
      { host, name: "control-model", respond: reply("Noted, Alice.") },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:model").send("Alice asks.", { auth: null });
        const events = await eventually(runtime, sent.sessionId, held("model"));
        await vi.waitFor(() => expect(host.asked).toHaveLength(2));
        expect(ofType(events, "model.requested")).toEqual([]);
        expect(ofType(events, "turn.paused")).toEqual([]);
        expect(ofType(events, "interaction.opened")).toEqual([]);
        expect(ofType(events, "turn.held").map((event) => event.data)).toEqual([
          { boundary: "model", reason: "Bob paused", turnId: host.asked[0]!.turnId },
        ]);

        host.decide(() => PROCEED);
        await command(runtime, sent.sessionId, "resume", "resume-1");
        expect(await sent.result()).toMatchObject({ reply: "Noted, Alice.", status: "completed" });
        const after = await recorded(runtime, sent.sessionId);
        expect(ofType(after, "model.requested")).toHaveLength(1);
        expect(settledControls(after, ["resume-1"])).toEqual([["resume-1", "applied"]]);
        expect(await violations(runtime, sent.sessionId)).toEqual([]);
      },
    );
    expect(agent.prompts).toHaveLength(1);
  });

  it("goes on without a resume when the control proceeds once the hold is recorded", async () => {
    const host = hostControl(({ call }) => (call === 1 ? PAUSED : PROCEED));
    const agent = await withControlledAgent(
      { host, name: "control-race", respond: reply("Noted, Alice.") },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:race").send("Alice asks.", { auth: null });
        expect(await sent.result()).toMatchObject({ status: "completed" });
        const events = await recorded(runtime, sent.sessionId);
        expect(ofType(events, "turn.held")).toHaveLength(1);
        expect(ofType(events, "model.requested")).toHaveLength(1);
      },
    );
    expect(agent.prompts).toHaveLength(1);
    expect(host.asked).toHaveLength(2);
  });

  it("holds a step's tool calls until resume, then runs each once", async () => {
    const host = hostControl(({ boundary }) => (boundary === "tools" ? PAUSED : PROCEED));
    const agent = await withControlledAgent(
      { host, name: "control-tools", respond: lookupThenReply, tools: [{ name: "lookup" }] },
      async ({ runtime }, { ran }) => {
        const sent = await alice(runtime, "control:tools").send("Alice asks for a lookup.", {
          auth: null,
        });
        const events = await eventually(runtime, sent.sessionId, held("tools"));
        await vi.waitFor(() =>
          expect(host.asked.filter(({ boundary }) => boundary === "tools")).toHaveLength(2),
        );
        expect(ofType(events, "model.settled").map((event) => event.data.outcome)).toEqual([
          "completed",
        ]);
        expect(ofType(events, "call.requested")).toHaveLength(1);
        expect(ofType(events, "call.started")).toEqual([]);
        expect(ran).toEqual([]);

        await command(runtime, sent.sessionId, "resume", "resume-early");
        await vi.waitFor(() =>
          expect(host.asked.filter(({ boundary }) => boundary === "tools")).toHaveLength(3),
        );
        expect(ran).toEqual([]);

        host.decide(() => PROCEED);
        await command(runtime, sent.sessionId, "resume", "resume-late");
        expect(await sent.result()).toMatchObject({
          reply: "Alice, the lookup is done.",
          status: "completed",
        });
        const after = await recorded(runtime, sent.sessionId);
        expect(ofType(after, "call.started")).toHaveLength(1);
        expect(ofType(after, "call.settled").map((event) => event.data.outcome)).toEqual([
          "completed",
        ]);
        expect(await violations(runtime, sent.sessionId)).toEqual([]);
      },
    );
    expect(agent.ran).toEqual(["lookup"]);
    expect(agent.prompts).toHaveLength(2);
  });

  it("accepts a resume when nothing is held, and duplicate resumes, without changing the turn", async () => {
    const host = hostControl(() => PROCEED);
    const agent = await withControlledAgent(
      { host, name: "control-idle-resume", respond: reply("Noted, Alice.") },
      async ({ runtime, settled }) => {
        const first = await alice(runtime, "control:idle").send("Alice asks.", { auth: null });
        expect(await first.result()).toMatchObject({ status: "completed" });
        await command(runtime, first.sessionId, "resume", "resume-idle");
        await eventually(
          runtime,
          first.sessionId,
          (events) => settledControls(events, ["resume-idle"]).length === 1,
        );

        host.decide(() => PAUSED);
        const second = await alice(runtime, "control:idle").send("Alice asks again.", {
          auth: null,
        });
        await eventually(runtime, second.sessionId, held("model"));
        host.decide(() => PROCEED);
        await command(runtime, second.sessionId, "resume", "resume-a");
        await command(runtime, second.sessionId, "resume", "resume-b");
        expect(await second.result()).toMatchObject({ status: "completed" });
        await settled();
        const events = await eventually(
          runtime,
          second.sessionId,
          (all) => settledControls(all, ["resume-a", "resume-b"]).length === 2,
        );
        expect(settledControls(events, ["resume-idle"])).toEqual([["resume-idle", "ignored"]]);
        expect(ofType(events, "turn.started")).toHaveLength(2);
        expect(ofType(events, "model.requested")).toHaveLength(2);
        expect(await violations(runtime, second.sessionId)).toEqual([]);
      },
    );
    expect(agent.prompts).toHaveLength(2);
  });

  it("cancels a held turn, and starts no step after", async () => {
    const host = hostControl(() => PAUSED);
    const agent = await withControlledAgent(
      { host, name: "control-cancel", respond: reply("Noted, Alice.") },
      async ({ runtime, settled }) => {
        const sent = await alice(runtime, "control:cancel").send("Alice asks.", { auth: null });
        await eventually(runtime, sent.sessionId, held("model"));
        await vi.waitFor(() => expect(host.asked).toHaveLength(2));
        await command(runtime, sent.sessionId, "cancel", "cancel-1");
        const events = await eventually(runtime, sent.sessionId, (all) =>
          ofType(all, "turn.settled").some((event) => event.data.outcome === "cancelled"),
        );
        const asked = host.asked.length;
        host.decide(() => PROCEED);
        await command(runtime, sent.sessionId, "resume", "resume-after-cancel");
        await settled();
        expect(ofType(events, "model.requested")).toEqual([]);
        expect(host.asked).toHaveLength(asked);
        expect(await violations(runtime, sent.sessionId)).toEqual([]);
      },
    );
    expect(agent.prompts).toEqual([]);
  });

  it("ends a session whose turn is held, and starts no step after", async () => {
    const host = hostControl(() => PAUSED);
    const agent = await withControlledAgent(
      { host, name: "control-end", respond: reply("Noted, Alice.") },
      async ({ runtime, settled }) => {
        const sent = await alice(runtime, "control:end").send("Alice asks.", { auth: null });
        await eventually(runtime, sent.sessionId, held("model"));
        await vi.waitFor(() => expect(host.asked).toHaveLength(2));
        const asked = host.asked.length;
        const reading = untilEnded(runtime, sent.sessionId);
        await command(runtime, sent.sessionId, "reset", "end-1");
        const events = await reading;
        host.decide(() => PROCEED);
        await settled();
        expect(ofType(events, "session.ended")).toHaveLength(1);
        expect(ofType(events, "model.requested")).toEqual([]);
        expect(host.asked).toHaveLength(asked);
      },
    );
    expect(agent.prompts).toEqual([]);
  });

  it("gives an update to the model once, records it, and acknowledges it after the step", async () => {
    const acked = new Set<string>();
    const update = { from: "Bob", instructionId: "update-1", text: "Use metric units." };
    const host = hostControl(({ boundary }) =>
      boundary === "model" && !acked.has(update.instructionId)
        ? { instructions: [update], proceed: true }
        : PROCEED,
    );
    const acknowledge = host.control.acknowledge.bind(host.control);
    host.control.acknowledge = async (input) => {
      acked.add(input.instructionId);
      await acknowledge(input);
    };
    const agent = await withControlledAgent(
      { host, name: "control-update", respond: lookupThenReply, tools: [{ name: "lookup" }] },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:update").send("Alice asks for a lookup.", {
          auth: null,
        });
        expect(await sent.result()).toMatchObject({ status: "completed" });
        const events = await recorded(runtime, sent.sessionId);
        expect(
          ofType(events, "delivery.consumed")
            .filter((event) => event.data.deliveryId === "instruction:update-1")
            .map((event) => event.data.parts),
        ).toEqual([[{ kind: "text", text: "Update from Bob: Use metric units." }]]);
        expect(await violations(runtime, sent.sessionId)).toEqual([]);
      },
    );
    expect(agent.prompts).toHaveLength(2);
    for (const prompt of agent.prompts)
      expect(prompt.split("Update from Bob: Use metric units.")).toHaveLength(2);
    expect(host.acknowledged.map(({ instructionId }) => instructionId)).toEqual(["update-1"]);
    expect(host.acknowledged[0]!.note).toContain("Given to the agent at model step");
  });

  it("doesn't acknowledge an update when its model step fails", async () => {
    const update = { from: "Bob", instructionId: "update-2", text: "Use metric units." };
    const host = hostControl(({ boundary }) =>
      boundary === "model" ? { instructions: [update], proceed: true } : PROCEED,
    );
    await withControlledAgent(
      {
        host,
        name: "control-update-failed",
        respond: () => {
          throw Object.assign(new Error("The provider rejected the request."), {
            isRetryable: false,
            statusCode: 400,
          });
        },
      },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:update-failed").send("Alice asks.", {
          auth: null,
        });
        const turn = await turnFrom(runtime, sent.sessionId);
        expect(ofType(turn, "model.settled").map((event) => event.data.outcome)).toEqual([
          "failed",
        ]);
        expect(ofType(turn, "delivery.consumed").map((event) => event.data.deliveryId)).toContain(
          "instruction:update-2",
        );
      },
    );
    expect(host.acknowledged).toEqual([]);
  });

  it("holds after a failing checkpoint, and goes on after resume once it answers", async () => {
    const host = hostControl(() => {
      throw new Error("The control store is unreachable.");
    });
    const agent = await withControlledAgent(
      { host, name: "control-throws", respond: reply("Noted, Alice.") },
      async ({ runtime }) => {
        const sent = await alice(runtime, "control:throws").send("Alice asks.", { auth: null });
        const events = await eventually(runtime, sent.sessionId, held("model"));
        expect(ofType(events, "turn.held").map((event) => event.data.reason)).toEqual([
          "The agent's control checkpoint failed.",
        ]);
        host.decide(() => PROCEED);
        await command(runtime, sent.sessionId, "resume", "resume-1");
        expect(await sent.result()).toMatchObject({ status: "completed" });
      },
    );
    expect(agent.prompts).toHaveLength(1);
  });

  it("keeps holding a turn across a restart, and goes on after resume", async () => {
    const host = hostControl(() => PAUSED);
    const agent = await withControlledAgent(
      { host, name: "control-restart", respond: reply("Noted, Alice.") },
      async ({ restart, runtime }) => {
        const sent = await alice(runtime, "control:restart").send("Alice asks.", { auth: null });
        await eventually(runtime, sent.sessionId, held("model"));
        await vi.waitFor(() => expect(host.asked).toHaveLength(2));
        await restart!();
        const asked = host.asked.length;
        expect(ofType(await recorded(runtime, sent.sessionId), "model.requested")).toEqual([]);

        host.decide(() => PROCEED);
        await command(runtime, sent.sessionId, "resume", "resume-1");
        const turn = await turnFrom(runtime, sent.sessionId);
        expect(ofType(turn, "turn.settled").map((event) => event.data.outcome)).toEqual([
          "completed",
        ]);
        expect(host.asked.length).toBeGreaterThan(asked);
        const events = await recorded(runtime, sent.sessionId);
        expect(ofType(events, "model.requested")).toHaveLength(1);
        expect(ofType(events, "turn.held")).toHaveLength(1);
      },
    );
    expect(agent.prompts).toHaveLength(1);
  });
});

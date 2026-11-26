import { transition } from "#harness/session-machine/commit.js";
import { expect, it, vi } from "vitest";

import { sandboxProvider } from "#context/providers/sandbox.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { fact } from "#harness/facts.js";
import { SessionStreamWriteError } from "#harness/session-stream-write-error.js";
import { readTurnState } from "#harness/session-machine/state.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const remembered = { interactionId: "approval-1", outcome: "accepted" as const };

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

it("keeps what the sandbox provider commits when a session step saves a transition", async () => {
  const runtime = await createTestRuntime({ agent: { name: "commit-session-step" } });
  const sessionWritable = new WritableStream<Uint8Array>();
  const captured = { session: null, snapshot: "captured-in-scope" };
  const commit = vi
    .spyOn(sandboxProvider, "commit")
    .mockImplementation(async (_access, session) => ({ ...session, sandboxState: captured }));
  try {
    const published = await runtime.run(() =>
      commitSessionStep(
        {
          serializedContext,
          sessionState: createTestSessionState(),
          sessionWritable,
          rerun: false,
        },
        (view) => [
          transition({
            events: [],
            turn: { ...view.turn, remembered: { deploy: remembered } },
          }),
        ],
        { origin: "relayed" },
      ),
    );
    expect(commit).toHaveBeenCalled();
    expect(published.sessionState.snapshot.session.sandboxState).toEqual(captured);
    expect(readTurnState(readDurableSession(published.sessionState).state).remembered).toEqual({
      deploy: remembered,
    });
  } finally {
    commit.mockRestore();
  }
});

const STREAM_DURABLE = Symbol.for("eve.workflow.stream.durable");

function startedCall() {
  return [
    fact("session.started", {}),
    fact("turn.started", { cause: { policy: "system" }, follows: null, turnId: "turn_0" }),
    fact("model.requested", { owner: { turnId: "turn_0" }, runId: "run_0" }),
    fact("model.started", { attempt: 0, modelId: "mock", runId: "run_0" }),
    fact("call.requested", {
      callId: "call-transfer",
      capability: { kind: "tool", name: "start_transfer" },
      input: { amount: 40 },
      owner: { runId: "run_0" },
    }),
    fact("call.started", { callId: "call-transfer" }),
  ];
}

function durableWritable(barrier: () => Promise<void>): WritableStream<Uint8Array> {
  const writable = new WritableStream<Uint8Array>();
  Object.defineProperty(writable, STREAM_DURABLE, { value: barrier });
  return writable;
}

async function publishStartedCall(sessionWritable: WritableStream<Uint8Array>) {
  const runtime = await createTestRuntime({ agent: { name: "commit-session-step" } });
  return await runtime.run(() =>
    commitSessionStep(
      { serializedContext, sessionState: createTestSessionState(), sessionWritable, rerun: false },
      (view) => [transition({ turn: view.turn, events: startedCall() })],
      { origin: "relayed" },
    ),
  );
}

it("does not finish publishing a started call until the session stream holds it durably", async () => {
  const order: string[] = [];
  await publishStartedCall(
    durableWritable(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("durable");
    }),
  );
  order.push("published");
  expect(order).toEqual(["durable", "published"]);
});

it("fails publishing a started call that the session stream cannot make durable", async () => {
  await expect(
    publishStartedCall(
      durableWritable(async () => {
        throw new Error("the stream could not be made durable");
      }),
    ),
  ).rejects.toThrow(SessionStreamWriteError);
});

import { describe, expect, it } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import type { Usage } from "./envelope.js";
import type { ModelComposedData } from "./families/model.js";
import { modelCalls } from "./model-calls.js";

const started = (runId: string, attempt: number): SessionEvent => ({
  data: { attempt, modelId: "anthropic/claude-sonnet-5", runId },
  type: "model.started",
});
const usage = (runId: string, recorded: Usage): SessionEvent => ({
  data: { kind: "model", owner: { runId }, usage: recorded },
  type: "usage.recorded",
});
const settled = (runId: string): SessionEvent => ({
  data: { outcome: "completed", runId },
  type: "model.settled",
});
const composed = (runId: string, attempt: number, send = 0): SessionEvent => ({
  data: {
    attempt,
    cache: { markers: 2 },
    estimator: "eve-bytes-4",
    messages: 3,
    prefixHash: "a".repeat(64),
    provider: "anthropic.messages",
    providerModelId: "claude-sonnet-5",
    requestHash: "b".repeat(64),
    runId,
    send,
    tokens: { history: 60, summaries: 0, system: 10, toolOutputs: 20, tools: 30, total: 100 },
  } satisfies ModelComposedData,
  type: "model.composed",
});
const spent = { cacheReadTokens: 600, cacheWriteTokens: 100, inputTokens: 1_000, outputTokens: 40 };

describe("modelCalls", () => {
  it("reads a session recorded before composition existed, leaving composition unknown", () => {
    const [call] = modelCalls([
      { data: { owner: { turnId: "turn_0" }, runId: "run_0" }, type: "model.requested" },
      started("run_0", 0),
      usage("run_0", spent),
      settled("run_0"),
    ]);
    expect(call).toEqual({
      attempt: 0,
      cache: { readShare: 0.6, reported: true, requested: undefined },
      modelId: "anthropic/claude-sonnet-5",
      outcome: "completed",
      owner: { turnId: "turn_0" },
      runId: "run_0",
      sends: 0,
      usage: {
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        costUsd: null,
        inputTokens: 1_000,
        outputTokens: 40,
      },
    });
  });

  it("joins usage to the attempt that spent it, by run, and counts sends within an attempt", () => {
    const calls = modelCalls([
      started("run_0", 0),
      composed("run_0", 0),
      {
        data: { attempt: 0, error: { code: "X", message: "x" }, runId: "run_0" },
        type: "model.retried",
      },
      usage("run_0", { ...spent, cacheReadTokens: 0 }),
      started("run_1", 0),
      composed("run_1", 0),
      started("run_0", 1),
      composed("run_0", 1),
      composed("run_0", 1, 1),
      usage("run_0", spent),
      settled("run_0"),
    ]);
    expect(calls.map((call) => [call.runId, call.attempt, call.outcome, call.sends])).toEqual([
      ["run_0", 0, "retried", 1],
      ["run_1", 0, "open", 1],
      ["run_0", 1, "completed", 2],
    ]);
    expect(calls.map((call) => call.usage?.cacheReadTokens)).toEqual([0, undefined, 600]);
    expect(calls[2]!.cache).toEqual({ readShare: 0.6, reported: true, requested: true });
  });

  it("reports unreported counts as unknown and calculates no share from them", () => {
    const [call] = modelCalls([
      started("run_0", 0),
      usage("run_0", {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 1_000,
        outputTokens: 40,
        unreported: ["cacheReadTokens", "cacheWriteTokens"],
      }),
    ]);
    expect(call!.usage).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null });
    expect(call!.cache).toEqual({ reported: false, requested: undefined });
  });

  it("calculates no share when the input excludes cached tokens", () => {
    const [call] = modelCalls([
      started("run_0", 0),
      usage("run_0", { ...spent, cacheReadTokens: 5_000, inputTokens: 200 }),
    ]);
    expect(call!.cache).toEqual({ reported: true, requested: undefined });
  });
});

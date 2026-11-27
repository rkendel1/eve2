import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createEveHost, type EveHostStore } from "#public/experimental/host/index.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { defineDynamic } from "#dynamic/definition.js";
import { composeRequest } from "#harness/model-call/composition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelComposedData } from "#protocol/session-events/families/model.js";
import { type ModelCall, modelCalls } from "#protocol/session-events/model-calls.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Reported = { readonly cacheRead?: number; readonly cacheWrite?: number };

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "feltkit:meetings",
  issuer: "org-a",
  principalId: "alice",
  principalType: "user",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function finish(
  unified: "stop" | "tool-calls",
  reported: Reported | undefined,
  sent: number,
): StreamPart {
  const cached = (reported?.cacheRead ?? 0) + (reported?.cacheWrite ?? 0);
  return {
    finishReason: { raw: undefined, unified },
    type: "finish",
    usage: {
      inputTokens: {
        cacheRead: reported?.cacheRead,
        cacheWrite: reported?.cacheWrite,
        noCache: sent,
        total: sent + cached,
      },
      outputTokens: { reasoning: undefined, text: 5, total: 5 },
    },
  };
}

function streamOf(chunks: readonly StreamPart[]): StreamResult {
  return { stream: simulateReadableStream({ chunks: [...chunks] }) };
}

const answer = (text: string, sent: number, reported?: Reported) =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "a", type: "text-start" },
    { delta: text, id: "a", type: "text-delta" },
    { id: "a", type: "text-end" },
    finish("stop", reported, sent),
  ]);

const fetchReport = (size: number, id: string, sent: number, reported?: Reported) =>
  streamOf([
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify({ size }),
      toolCallId: id,
      toolName: "fetch_report",
      type: "tool-call",
    },
    finish("tool-calls", reported, sent),
  ]);

const overloaded = () =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" },
  ]);

function userText(prompt: Parameters<MockLanguageModelV4["doStream"]>[0]["prompt"]): string {
  const last = prompt.findLast((message) => message.role === "user");
  return last?.role === "user"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
}

function scriptedModel(options: {
  readonly reported?: Reported;
  readonly before?: readonly ("busy" | "overloaded")[];
}) {
  const before = [...(options.before ?? [])];
  let calls = 0;
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const fault = before.shift();
        if (fault === "busy") {
          throw new APICallError({
            isRetryable: true,
            message: "busy",
            requestBodyValues: {},
            statusCode: 503,
            url: "https://models.invalid/v1",
          });
        }
        if (fault === "overloaded") return overloaded();
        const sent = Math.ceil(JSON.stringify(prompt).length / 4);
        if (tools === undefined || tools.length === 0) {
          return answer("Alice fetched two large reports and asked about them.", sent);
        }
        if (prompt.at(-1)?.role === "tool") return answer("Read it.", sent, options.reported);
        const asked = /fetch (\d+)/.exec(userText(prompt));
        if (asked !== null) {
          return fetchReport(Number(asked[1]), `call-${++calls}`, sent, options.reported);
        }
        return answer(`Heard ${userText(prompt).length} characters.`, sent, options.reported);
      },
      modelId: "composition-scripted",
      provider: "eve-test",
    }),
  );
}

async function converse(input: {
  readonly messages: readonly string[];
  readonly model: MockLanguageModelV4;
  readonly window?: number;
}): Promise<SessionEvent[]> {
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({
          model: input.model,
          modelContextWindowTokens: input.window ?? 1_000_000,
        })),
      }),
      name: "composition",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Fetches Alice's report of the requested size.",
            execute: async ({ size }: { size: number }) => ({ report: "r".repeat(size) }),
            inputSchema: {
              properties: { size: { type: "number" } },
              required: ["size"],
              type: "object",
            },
          }),
        }),
        logicalPath: "tools/fetch_report.ts",
      },
    ],
  });
  return await test.run(async () => {
    const runtime = createTestInProcessRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    try {
      const alice = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: `alice-composition-${Math.random()}`,
        runtime,
      });
      let sessionId = "";
      for (const message of input.messages) {
        sessionId = (await (await alice.send(message, { auth: null })).result()).sessionId;
      }
      const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
      const events: SessionEvent[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        events.push(next.value);
      }
      return events;
    } finally {
      await runtime.dispose();
    }
  });
}

const composed = (events: readonly SessionEvent[]) =>
  events.flatMap((event) => (event.type === "model.composed" ? [event.data] : []));

function measured(data: ModelComposedData) {
  const { attempt: _attempt, runId: _runId, send: _send, ...composition } = data;
  return composition;
}

function expectReconciled(calls: readonly ModelCall[]) {
  for (const { composition } of calls) {
    if (composition === undefined) continue;
    const { history, summaries, system, toolOutputs, tools, total } = composition.tokens;
    expect(total).toBe(system + tools + history);
    expect(toolOutputs + summaries).toBeLessThanOrEqual(history);
  }
}

const turns = (count: number) =>
  Array.from({ length: count }, (_, i) => `Alice adds note ${i + 1} on the release plan.`);

describe("model call composition, measured on the request the provider received", () => {
  it("records each provider call's composition, attached to its run and attempt", async () => {
    const model = scriptedModel({});
    const events = await converse({ messages: ["Alice asks Bob to fetch 4000."], model });
    const facts = composed(events);
    expect(facts).toHaveLength(2);
    expect(facts.map(measured)).toEqual(
      model.doStreamCalls.map((call) => composeRequest(call, model)),
    );
    for (const fact of facts) {
      const started = events.findIndex(
        (event) =>
          event.type === "model.started" &&
          event.data.runId === fact.runId &&
          event.data.attempt === fact.attempt,
      );
      const at = events.findIndex(
        (event) => event.type === "model.composed" && event.data === fact,
      );
      expect(started).toBeGreaterThanOrEqual(0);
      expect(at).toBeGreaterThan(started);
    }
    const [asked, read] = facts;
    expect(asked!.runId).not.toBe(read!.runId);
    expect(asked!.tokens.toolOutputs).toBe(0);
    expect(read!.tokens.toolOutputs).toBeGreaterThan(1_000);
    expect(read!.tokens.history - asked!.tokens.history).toBeGreaterThanOrEqual(
      read!.tokens.toolOutputs,
    );
    expect(read!.tokens.total).toBe(
      read!.tokens.system + read!.tokens.tools + read!.tokens.history,
    );
    expect(read!.prefixHash).toBe(asked!.prefixHash);
    expect(read!.requestHash).not.toBe(asked!.requestHash);
    expect(asked).toMatchObject({
      estimator: "eve-bytes-4",
      provider: "eve-test",
      providerModelId: "composition-scripted",
      send: 0,
    });
  }, 60_000);

  it("joins each call's composition to the usage its provider reported", async () => {
    const model = scriptedModel({ reported: { cacheRead: 3_000, cacheWrite: 500 } });
    const calls = modelCalls(await converse({ messages: ["Alice says hello."], model }));
    expect(calls).toHaveLength(1);
    const input = calls[0]!.usage!.inputTokens!;
    expect(input).toBeGreaterThan(3_500);
    expect(calls[0]).toMatchObject({
      attempt: 0,
      cache: { readShare: 3_000 / input, reported: true, requested: false },
      outcome: "completed",
      sends: 1,
      usage: { cacheReadTokens: 3_000, cacheWriteTokens: 500, costUsd: null, outputTokens: 5 },
    });
    expect(calls[0]!.composition?.tokens.total).toBeGreaterThan(0);
  }, 60_000);

  it("keeps cache usage a provider did not report unknown, not zero", async () => {
    const events = await converse({ messages: ["Alice says hello."], model: scriptedModel({}) });
    const recorded = events.find((event) => event.type === "usage.recorded");
    expect(recorded?.type === "usage.recorded" && recorded.data.usage).toMatchObject({
      cacheReadTokens: 0,
      unreported: ["cacheReadTokens", "cacheWriteTokens"],
    });
    const [call] = modelCalls(events);
    expect(call!.usage).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null });
    expect(call!.cache).toEqual({ reported: false, requested: false });
  }, 60_000);

  it("tells eve's retried attempts apart from the model client resending one attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = scriptedModel({ before: ["overloaded", "busy"] });
    const calls = modelCalls(await converse({ messages: ["Alice says hello."], model }));
    expect(calls.map((call) => [call.attempt, call.outcome, call.sends])).toEqual([
      [0, "retried", 1],
      [1, "completed", 2],
    ]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(calls[1]!.composition?.requestHash).toBe(calls[0]!.composition?.requestHash);
  }, 60_000);

  it("accounts conversations as they grow, with tools, large outputs and compaction", async () => {
    const scenarios = {
      "5 turns": { messages: turns(5) },
      "20 turns": { messages: turns(20) },
      "50 turns": { messages: turns(50) },
      "tool-heavy": {
        messages: Array.from({ length: 10 }, (_, i) => `Alice asks Bob to fetch ${200 + i}.`),
      },
      "large tool outputs": {
        messages: ["Alice asks Bob to fetch 60000.", "Alice asks Bob to fetch 60000."],
      },
      "forced compaction": {
        messages: [
          "Alice asks Bob to fetch 60000.",
          "Alice asks Bob to fetch 60000.",
          "Alice asks what the reports said.",
        ],
        window: 30_000,
      },
    };
    const report: Record<string, unknown> = {};
    for (const [name, scenario] of Object.entries(scenarios)) {
      const model = scriptedModel({});
      const events = await converse({ ...scenario, model });
      const calls = modelCalls(events);
      expectReconciled(calls);
      const measuredCalls = calls.filter((call) => call.composition !== undefined);
      const recomputed = new Set(
        model.doStreamCalls.map((call) => composeRequest(call, model).requestHash),
      );
      for (const call of measuredCalls) expect(recomputed).toContain(call.composition!.requestHash);
      const changes = events.filter((event) => event.type === "context.started").length;
      expect(measuredCalls.length + changes).toBeGreaterThanOrEqual(model.doStreamCalls.length);
      if (name === "forced compaction") {
        expect(changes).toBeGreaterThan(0);
        expect(measuredCalls.at(-1)!.composition!.tokens.summaries).toBeGreaterThan(0);
      } else {
        expect(changes).toBe(0);
        const histories = measuredCalls.map((call) => call.composition!.tokens.history);
        expect(histories).toEqual([...histories].sort((a, b) => a - b));
        expect(new Set(measuredCalls.map((call) => call.composition!.prefixHash)).size).toBe(1);
      }
      report[name] = measuredCalls.map((call) => ({
        ...call.composition!.tokens,
        attempt: call.attempt,
        messages: call.composition!.messages,
        reported: call.usage,
      }));
    }
    if (process.env.EVE_COMPOSITION_REPORT !== undefined) console.info(JSON.stringify(report));
  }, 300_000);

  it("keeps the composition in the durable record and measures a resumed session the same way", async () => {
    const model = scriptedModel({});
    const lines = new Map<string, string[]>();
    const sessions = new Map<string, string>();
    let generation = 0;
    const open = (): EveHostStore & { kill(): void } => {
      const mine = ++generation;
      const alive = () => {
        if (mine !== generation) throw new Error("this host is gone");
      };
      return {
        async appendLine(sessionId, index, line) {
          alive();
          const stream = lines.get(sessionId) ?? [];
          if (index !== stream.length) throw new Error(`line ${index} is not the next line`);
          lines.set(sessionId, [...stream, line]);
        },
        kill: () => void generation++,
        async readLines(sessionId) {
          return [...(lines.get(sessionId) ?? [])];
        },
        async readSessions() {
          return [...sessions].map(([sessionId, record]) => ({ record, sessionId }));
        },
        async saveSession(sessionId, record) {
          alive();
          sessions.set(sessionId, record);
        },
      };
    };
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => {
            throw new Error("The host resolves the model.");
          }),
        }),
        name: "composition-host",
      },
    });
    const host = (store: EveHostStore) =>
      createEveHost({
        agent: readBundledCompiledArtifacts()!,
        models: { resolve: () => model },
        store,
      });
    await test.run(async () => {
      const first = open();
      const before = host(first);
      const meeting = before.connect({ application: "meetings", conversation: "weekly" });
      await (await meeting.send("Alice adds the first note.", { auth: ALICE })).result();
      const { sessionId } = await (
        await meeting.send("Alice adds the second note.", { auth: ALICE })
      ).result();
      await before.idle();
      first.kill();
      await before.dispose().catch(() => {});

      const after = host(open());
      expect((await after.restoration).restored).toEqual([sessionId]);
      const again = after.connect({ application: "meetings", conversation: "weekly" });
      const resumedTurn = await (
        await again.send("Alice adds a note after the restart.", { auth: ALICE })
      ).result();
      expect(resumedTurn.sessionId).toBe(sessionId);
      await after.idle();
      await after.dispose();

      const persisted = (lines.get(sessionId) ?? []).flatMap((line) => {
        const parsed = JSON.parse(line) as { readonly facts?: readonly SessionEvent[] };
        return parsed.facts ?? [];
      });
      const calls = modelCalls(persisted);
      expect(calls).toHaveLength(3);
      expectReconciled(calls);
      const [one, second, resumed] = calls.map((call) => call.composition!);
      expect(new Set([one, second, resumed].map((c) => c!.prefixHash)).size).toBe(1);
      expect(resumed!.messages).toBeGreaterThan(second!.messages);
      expect(resumed!.tokens.history).toBeGreaterThan(second!.tokens.history);
      expect(calls.map((call) => call.usage?.inputTokens)).toEqual(
        model.doStreamCalls.map((call) => Math.ceil(JSON.stringify(call.prompt).length / 4)),
      );
    });
  }, 120_000);
});

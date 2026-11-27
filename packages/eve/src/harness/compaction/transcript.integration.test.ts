import type { ModelMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { decodeStoredSession, encodeStoredSession } from "#execution/in-process/session-store.js";
import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import {
  TRANSCRIPT_STATE_KEY,
  transcriptIsComplete,
  transcriptOf,
  transcriptRecord,
} from "#harness/session-machine/transcript.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { SessionStateMap } from "#harness/types.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { modelCalls } from "#protocol/session-events/model-calls.js";
import { createEveHost, type EveHost, type EveHostStore } from "#public/experimental/host/index.js";
import { defineAgent } from "#public/definitions/agent.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { defineTool } from "#tools/definition.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Prompt = Parameters<MockLanguageModelV4["doStream"]>[0]["prompt"];

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "feltkit:meetings",
  issuer: "org-a",
  principalId: "alice",
  principalType: "user",
};

const REPORT_CHARS = 60_000;

const finish = (unified: "stop" | "tool-calls", sent: number): StreamPart => ({
  finishReason: { raw: undefined, unified },
  type: "finish",
  usage: {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: sent, total: sent },
    outputTokens: { reasoning: undefined, text: 5, total: 5 },
  },
});

const streamOf = (chunks: readonly StreamPart[]): StreamResult => ({
  stream: simulateReadableStream({ chunks: [...chunks] }),
});

const answer = (text: string, sent: number) =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "a", type: "text-start" },
    { delta: text, id: "a", type: "text-delta" },
    { id: "a", type: "text-end" },
    finish("stop", sent),
  ]);

function textOf(prompt: Prompt, role: "user" | "tool"): string[] {
  return prompt.flatMap((message) =>
    message.role === role
      ? message.content.flatMap((part) =>
          part.type === "text"
            ? [part.text]
            : part.type === "tool-result"
              ? [JSON.stringify(part.output)]
              : [],
        )
      : [],
  );
}

interface Script {
  readonly summaries: string[];
  emptySummaries: number;
  holdSummary?: { readonly reached: () => void; readonly release: Promise<void> };
  readonly summaryPrompts: string[];
}

function scriptedModel(script: Script) {
  let summaryCount = 0;
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const sent = Math.ceil(JSON.stringify(prompt).length / 4);
        if (tools === undefined || tools.length === 0) {
          script.summaryPrompts.push(textOf(prompt, "user").join("\n"));
          if (script.holdSummary !== undefined) {
            script.holdSummary.reached();
            await script.holdSummary.release;
          }
          if (script.emptySummaries > 0) {
            script.emptySummaries--;
            return answer(" ", sent);
          }
          const summary = `SUMMARY-${++summaryCount}: Alice has been collecting reports.`;
          script.summaries.push(summary);
          return answer(summary, sent);
        }
        if (prompt.at(-1)?.role === "tool") {
          const [result] = textOf(prompt, "tool").slice(-1);
          return answer(`Read ${/REPORT-\d+/.exec(result ?? "")?.[0] ?? "nothing"}.`, sent);
        }
        const asked = /report (\d+)/.exec(textOf(prompt, "user").at(-1) ?? "");
        if (asked === null) return answer(`Noted: ${textOf(prompt, "user").at(-1)}`, sent);
        return streamOf([
          { type: "stream-start", warnings: [] },
          {
            input: JSON.stringify({ number: Number(asked[1]) }),
            toolCallId: `call-${asked[1]}-${Math.random().toString(36).slice(2, 8)}`,
            toolName: "fetch_report",
            type: "tool-call",
          },
          finish("tool-calls", sent),
        ]);
      },
      modelId: "transcript-scripted",
      provider: "eve-test",
    }),
  );
}

function durableStore(options: { readonly maxRecordBytes?: number } = {}) {
  const lines = new Map<string, string[]>();
  const records = new Map<string, string>();
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
        return [...records].map(([sessionId, record]) => ({ record, sessionId }));
      },
      async saveSession(sessionId, record) {
        alive();
        const max = options.maxRecordBytes;
        if (max !== undefined && Buffer.byteLength(record) > max) {
          throw new Error(`sessions: the record is larger than ${max} bytes.`);
        }
        records.set(sessionId, record);
      },
    };
  };
  const stored = (sessionId: string) => {
    const record = records.get(sessionId);
    if (record === undefined) throw new Error(`no record for ${sessionId}`);
    const checkpoint = decodeStoredSession(record).checkpoint!;
    const session = {
      history: checkpoint.history as HarnessModelMessage[],
      state: (checkpoint.sessionState as { snapshot: { session: { state?: SessionStateMap } } })
        .snapshot.session.state,
    };
    return { bytes: Buffer.byteLength(record), session, transcript: transcriptOf(session) };
  };
  const events = (sessionId: string): SessionEvent[] =>
    (lines.get(sessionId) ?? []).flatMap(
      (line) => (JSON.parse(line) as { readonly facts?: SessionEvent[] }).facts ?? [],
    );
  const forgetTranscript = (sessionId: string) => {
    const stored = decodeStoredSession(records.get(sessionId)!);
    const checkpoint = stored.checkpoint!;
    const sessionState = checkpoint.sessionState as {
      snapshot: { session: { state?: Record<string, unknown> } };
    };
    const { [TRANSCRIPT_STATE_KEY]: _dropped, ...state } =
      sessionState.snapshot.session.state ?? {};
    records.set(
      sessionId,
      encodeStoredSession({
        ...stored,
        checkpoint: {
          ...checkpoint,
          sessionState: {
            ...sessionState,
            snapshot: {
              ...sessionState.snapshot,
              session: { ...sessionState.snapshot.session, state },
            },
          } as typeof checkpoint.sessionState,
        },
      }),
    );
  };
  return { events, forgetTranscript, lines, open, records, stored };
}

const flat = (messages: readonly ModelMessage[]) => JSON.stringify(messages);

async function withAgent<T>(body: () => Promise<T>): Promise<T> {
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => {
          throw new Error("The host resolves the model.");
        }),
      }),
      name: "transcript",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Fetches one of Alice's numbered reports.",
            execute: async ({ number }: { number: number }) => ({
              report: `REPORT-${number} ${"r".repeat(REPORT_CHARS)}`,
            }),
            inputSchema: {
              properties: { number: { type: "number" } },
              required: ["number"],
              type: "object",
            },
          }),
        }),
        logicalPath: "tools/fetch_report.ts",
      },
    ],
  });
  return await test.run(body);
}

function newScript(): Script {
  return { emptySummaries: 0, summaries: [], summaryPrompts: [] };
}

function host(store: EveHostStore, model: MockLanguageModelV4): EveHost {
  return createEveHost({
    agent: readBundledCompiledArtifacts()!,
    models: { resolve: () => model },
    store,
  });
}

async function say(eve: EveHost, message: string) {
  const meeting = eve.connect({ application: "meetings", conversation: "reports" });
  return await (await meeting.send(message, { auth: ALICE })).result();
}

const asks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Alice asks Bob to fetch report ${from + i}.`);

const compactions = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === "context.started").length;

describe("non-destructive compaction on the host's durable store", () => {
  it("keeps every original message while the model works from a smaller projection", async () => {
    await withAgent(async () => {
      const script = newScript();
      const model = scriptedModel(script);
      const backing = durableStore();
      const eve = host(backing.open(), model);
      const first = await say(eve, "Alice starts collecting reports.");
      const { sessionId } = first;
      const before = backing.stored(sessionId);
      expect(transcriptRecord(before.session)).toBeUndefined();
      expect(before.transcript).toEqual(before.session.history);

      for (const message of asks(1, 16)) await say(eve, message);
      await say(eve, "Alice adds a closing note after the reports.");
      await eve.idle();
      await eve.dispose();

      const after = backing.stored(sessionId);
      const events = backing.events(sessionId);
      expect(compactions(events)).toBeGreaterThanOrEqual(2);
      const record = transcriptRecord(after.session)!;
      expect(record.partial).toBeUndefined();
      expect(transcriptIsComplete(after.session)).toBe(true);

      const transcript = flat(after.transcript);
      for (const message of ["Alice starts collecting reports.", ...asks(1, 16)]) {
        expect(transcript).toContain(message);
      }
      for (let n = 1; n <= 16; n++) {
        expect(transcript).toContain(`REPORT-${n} ${"r".repeat(REPORT_CHARS)}`);
        expect(transcript).toContain(`Read REPORT-${n}.`);
        expect(transcript).toMatch(new RegExp(`"toolCallId":"call-${n}-`));
      }
      expect(transcript).not.toContain(COMPACTION_CHECKPOINT_MARKER);
      for (const summary of script.summaries) expect(transcript).not.toContain(summary);

      const working = after.session.history;
      expect(flat(working.slice(0, 2))).toContain(COMPACTION_CHECKPOINT_MARKER);
      expect(flat(working)).toContain(script.summaries.at(-1)!);
      expect(estimateTokens(working)).toBeLessThan(estimateTokens(after.transcript) / 3);
      expect(working.at(-1)).toEqual(after.transcript.at(-1));
      expect(flat(working.slice(-2))).toContain("Alice adds a closing note after the reports.");

      const requests = model.doStreamCalls.filter((call) => (call.tools?.length ?? 0) > 0);
      const last = JSON.stringify(requests.at(-1)!.prompt);
      expect(last).toContain(script.summaries.at(-1)!);
      expect(last).not.toContain(`REPORT-1 ${"r".repeat(100)}`);
      expect(last.length).toBeLessThan(transcript.length / 3);
      const composed = modelCalls(events).at(-1)!.composition!;
      expect(composed.tokens.summaries).toBeGreaterThan(0);
      expect(composed.tokens.history).toBeLessThan(estimateTokens(after.transcript));

      const [, second] = script.summaryPrompts;
      const previous = /<previous-checkpoint>([\s\S]*?)<\/previous-checkpoint>/.exec(second!)![1]!;
      const conversation = /<conversation>([\s\S]*?)<\/conversation>/.exec(second!)![1]!;
      expect(previous).toContain(script.summaries[0]!);
      expect(conversation).not.toContain(script.summaries[0]!);
    });
  }, 240_000);

  it("restores the complete transcript and the current projection after the host dies", async () => {
    await withAgent(async () => {
      const model = scriptedModel(newScript());
      const backing = durableStore();
      const firstStore = backing.open();
      const before = host(firstStore, model);
      let sessionId = "";
      for (const message of asks(1, 9)) sessionId = (await say(before, message)).sessionId;
      await before.idle();
      const killed = backing.stored(sessionId);
      expect(compactions(backing.events(sessionId))).toBeGreaterThan(0);
      firstStore.kill();
      await before.dispose().catch(() => {});

      const after = host(backing.open(), model);
      expect((await after.restoration).restored).toEqual([sessionId]);
      const resumed = await say(after, "Alice asks what the reports had in common.");
      expect(resumed.sessionId).toBe(sessionId);
      await after.idle();
      await after.dispose();

      const restored = backing.stored(sessionId);
      expect(restored.transcript.slice(0, killed.transcript.length)).toEqual(killed.transcript);
      expect(flat(restored.transcript.slice(killed.transcript.length))).toContain(
        "Alice asks what the reports had in common.",
      );
      const projected = transcriptRecord(restored.session)!.projected;
      expect(restored.session.history.slice(0, projected)).toEqual(
        killed.session.history.slice(0, projected),
      );
      expect(flat(restored.session.history.slice(projected))).toContain(
        "Alice asks what the reports had in common.",
      );
      const lastRequest = JSON.stringify(model.doStreamCalls.at(-1)!.prompt);
      expect(lastRequest).toContain(COMPACTION_CHECKPOINT_MARKER);
    });
  }, 240_000);

  it("leaves the persisted record whole when the host dies during a compaction", async () => {
    await withAgent(async () => {
      const script = newScript();
      let reached!: () => void;
      const atSummary = new Promise<void>((resolve) => (reached = resolve));
      script.holdSummary = { reached: () => reached(), release: new Promise<void>(() => {}) };
      const model = scriptedModel(script);
      const backing = durableStore();
      const firstStore = backing.open();
      const before = host(firstStore, model);
      let sessionId = "";
      const pending = (async () => {
        for (const message of asks(1, 9)) sessionId = (await say(before, message)).sessionId;
      })().catch(() => {});
      await atSummary;
      const persisted = backing.stored(sessionId);
      firstStore.kill();
      await before.dispose().catch(() => {});
      void pending;

      expect(transcriptRecord(persisted.session)).toBeUndefined();
      expect(persisted.transcript).toEqual(persisted.session.history);
      expect(flat(persisted.transcript)).toContain(`REPORT-1 ${"r".repeat(REPORT_CHARS)}`);

      const healthy = newScript();
      const after = host(backing.open(), scriptedModel(healthy));
      expect((await after.restoration).restored).toEqual([sessionId]);
      await say(after, "Alice asks Bob to fetch report 10.");
      await after.idle();
      await after.dispose();
      const resumed = backing.stored(sessionId);
      expect(resumed.transcript.slice(0, persisted.transcript.length)).toEqual(
        persisted.transcript,
      );
      expect(flat(resumed.transcript)).toContain("REPORT-10 ");
    });
  }, 240_000);

  it("keeps the history when the summary fails, says so, and compacts on a later turn", async () => {
    await withAgent(async () => {
      const script = newScript();
      script.emptySummaries = 1;
      const model = scriptedModel(script);
      const backing = durableStore();
      const eve = host(backing.open(), model);
      let sessionId = "";
      let failedAt: ReturnType<typeof backing.stored> | undefined;
      for (const message of asks(1, 16)) {
        const result = await say(eve, message);
        sessionId = result.sessionId;
        const events = backing.events(sessionId);
        if (failedAt === undefined && events.some(failedCompaction)) {
          failedAt = backing.stored(sessionId);
        }
      }
      await eve.idle();
      await eve.dispose();
      expect(failedAt).toBeDefined();
      expect(transcriptRecord(failedAt!.session)).toBeUndefined();
      expect(flat(failedAt!.session.history)).toContain(`REPORT-1 ${"r".repeat(REPORT_CHARS)}`);
      const final = backing.stored(sessionId);
      expect(transcriptRecord(final.session)).toBeDefined();
      for (let n = 1; n <= 16; n++) expect(flat(final.transcript)).toContain(`REPORT-${n} `);
    });
  }, 240_000);

  it("ends the session explicitly and keeps the last whole record when it outgrows its store", async () => {
    await withAgent(async () => {
      const model = scriptedModel(newScript());
      const backing = durableStore({ maxRecordBytes: 900_000 });
      const eve = host(backing.open(), model);
      let sessionId = "";
      let lastWhole: ReturnType<typeof backing.stored> | undefined;
      let fetched = 0;
      let refused: Awaited<ReturnType<typeof say>> | undefined;
      for (const message of asks(1, 40)) {
        const result = await say(eve, message);
        if (result.status === "failed") {
          refused = result;
          break;
        }
        sessionId = result.sessionId;
        lastWhole = backing.stored(sessionId);
        fetched++;
      }
      await eve.dispose().catch(() => {});
      expect(refused).toMatchObject({
        error: { code: "WORKFLOW_EXECUTION_FAILED" },
        sessionEnded: true,
        sessionId,
      });
      expect(compactions(backing.events(sessionId))).toBeGreaterThan(0);
      const kept = backing.stored(sessionId);
      expect(kept.bytes).toBeLessThanOrEqual(900_000);
      expect(kept.transcript.slice(0, lastWhole!.transcript.length)).toEqual(lastWhole!.transcript);
      const reports = [...flat(kept.transcript).matchAll(/REPORT-(\d+) r/g)].map((m) => m[1]);
      expect(reports).toEqual(Array.from({ length: fetched }, (_, i) => String(i + 1)));
    });
  }, 240_000);
  it("restores a session compacted before transcripts were kept, and says its record is partial", async () => {
    await withAgent(async () => {
      const model = scriptedModel(newScript());
      const backing = durableStore();
      const firstStore = backing.open();
      const before = host(firstStore, model);
      let sessionId = "";
      for (const message of asks(1, 9)) sessionId = (await say(before, message)).sessionId;
      await before.idle();
      firstStore.kill();
      await before.dispose().catch(() => {});
      backing.forgetTranscript(sessionId);
      const legacy = backing.stored(sessionId);
      expect(transcriptRecord(legacy.session)).toBeUndefined();
      expect(transcriptIsComplete(legacy.session)).toBe(false);

      const after = host(backing.open(), model);
      expect((await after.restoration).restored).toEqual([sessionId]);
      for (const message of asks(10, 18)) {
        expect((await say(after, message)).sessionId).toBe(sessionId);
      }
      await after.idle();
      await after.dispose();
      const resumed = backing.stored(sessionId);
      expect(transcriptRecord(resumed.session)?.partial).toBe(true);
      expect(transcriptIsComplete(resumed.session)).toBe(false);
      expect(resumed.transcript.slice(0, legacy.session.history.length)).toEqual(
        legacy.session.history,
      );
      for (let n = 10; n <= 18; n++) expect(flat(resumed.transcript)).toContain(`REPORT-${n} r`);
    });
  }, 240_000);
  it("grows the record as the conversation does while the model's context stays bounded", async () => {
    await withAgent(async () => {
      const model = scriptedModel(newScript());
      const backing = durableStore();
      const firstStore = backing.open();
      const before = host(firstStore, model);
      const rows: {
        readonly archiveBytes: number;
        readonly compactions: number;
        readonly recordBytes: number;
        readonly requestTokens: number;
        readonly summaryTokens: number;
        readonly transcriptTokens: number;
        readonly workingTokens: number;
      }[] = [];
      let sessionId = "";
      for (const message of asks(1, 30)) {
        sessionId = (await say(before, message)).sessionId;
        const { bytes, session, transcript } = backing.stored(sessionId);
        const events = backing.events(sessionId);
        const last = modelCalls(events).at(-1)!.composition!.tokens;
        const archived = transcriptRecord(session)?.archived ?? [];
        rows.push({
          archiveBytes: Buffer.byteLength(JSON.stringify(archived)),
          compactions: compactions(events),
          recordBytes: bytes,
          requestTokens: last.total,
          summaryTokens: last.summaries,
          transcriptTokens: estimateTokens(transcript),
          workingTokens: estimateTokens(session.history),
        });
      }
      await before.idle();
      const killed = backing.stored(sessionId);
      firstStore.kill();
      await before.dispose().catch(() => {});
      const after = host(backing.open(), model);
      expect((await after.restoration).restored).toEqual([sessionId]);
      await after.dispose();
      expect(backing.stored(sessionId).transcript).toEqual(killed.transcript);

      const final = rows.at(-1)!;
      expect(final.compactions).toBeGreaterThanOrEqual(3);
      expect(final.transcriptTokens).toBeGreaterThan(400_000);
      expect(Math.max(...rows.map((row) => row.workingTokens))).toBeLessThan(110_000);
      expect(Math.max(...rows.map((row) => row.requestTokens))).toBeLessThan(115_000);
      for (const [i, row] of rows.entries()) {
        if (i > 0) expect(row.transcriptTokens).toBeGreaterThan(rows[i - 1]!.transcriptTokens);
      }
      if (process.env.EVE_COMPOSITION_REPORT !== undefined) console.info(JSON.stringify(rows));
    });
  }, 240_000);
});

function failedCompaction(event: SessionEvent): boolean {
  return event.type === "context.settled" && event.data.outcome === "failed";
}

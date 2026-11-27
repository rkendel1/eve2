import { describe, expect, it } from "vitest";

import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import { createUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { changeHistory } from "./history.js";
import {
  TRANSCRIPT_STATE_KEY,
  transcriptIsComplete,
  transcriptOf,
  transcriptRecord,
} from "./transcript.js";

const user = (text: string) => createUserMessage("user", text);
const assistant = (text: string): HarnessModelMessage => ({ content: text, role: "assistant" });
const summary = (text: string): HarnessModelMessage[] => [
  createUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
  assistant(text),
];

const original = [user("Alice asks for the plan."), assistant("Here it is."), user("And dates?")];
const session = (
  history: HarnessModelMessage[] = original,
): {
  compaction: {};
  history: HarnessModelMessage[];
  state?: Readonly<Record<string, unknown>>;
} => ({
  compaction: {},
  history,
});

describe("the transcript beside a compacted history", () => {
  it("keeps every original message when compaction replaces the working history", () => {
    const compacted = changeHistory(session(), {
      compact: [...summary("Alice wants the plan."), user("And dates?")],
    });
    expect(compacted.history[1]).toEqual(assistant("Alice wants the plan."));
    expect(transcriptOf(compacted)).toEqual(original);
    const next = changeHistory(compacted, { append: [assistant("Friday.")] });
    expect(transcriptOf(next)).toEqual([...original, assistant("Friday.")]);
    const again = changeHistory(next, {
      compact: [...summary("Alice wants the plan by Friday.")],
    });
    expect(transcriptOf(again)).toEqual([...original, assistant("Friday.")]);
    expect(transcriptIsComplete(again)).toBe(true);
  });

  it("follows the projection when a change inserts messages around it", () => {
    const compacted = changeHistory(session(), { compact: summary("Alice wants the plan.") });
    const inserted = createUserMessage("context.instruction", "Reply in English.");
    const extended = changeHistory(compacted, {
      extend: [compacted.history[0]!, inserted, compacted.history[1]!, assistant("Noted.")],
    });
    expect(transcriptRecord(extended)?.projected).toBe(3);
    expect(transcriptOf(extended)).toEqual([...original, assistant("Noted.")]);
  });

  it("keeps the transcript when a repair changes the projection itself", () => {
    const compacted = changeHistory(session(), { compact: summary("Alice wants the plan.") });
    const appended = changeHistory(compacted, { append: [user("Bob joins.")] });
    const repaired = changeHistory(appended, { repaired: [assistant("Repaired.")] });
    expect(transcriptOf(repaired)).toEqual([...original, user("Bob joins.")]);
    const after = changeHistory(repaired, { append: [assistant("Welcome, Bob.")] });
    expect(transcriptOf(after)).toEqual([
      ...original,
      user("Bob joins."),
      assistant("Welcome, Bob."),
    ]);
  });

  it("drops the transcript only when the conversation is cleared", () => {
    const compacted = changeHistory(session(), { compact: summary("Alice wants the plan.") });
    const cleared = changeHistory(compacted, { rewrite: [] });
    expect(cleared.state?.[TRANSCRIPT_STATE_KEY]).toBeUndefined();
    expect(transcriptOf(cleared)).toEqual([]);
  });

  it("leaves a session without compaction exactly as it was", () => {
    const appended = changeHistory(session(), { append: [assistant("Friday.")] });
    expect(appended.state).toBeUndefined();
    expect(transcriptOf(appended)).toEqual(appended.history);
  });

  it("marks a transcript partial when it starts from a summary eve wrote before keeping transcripts", () => {
    const legacy = session([...summary("Earlier work."), user("Alice continues.")]);
    expect(transcriptIsComplete(legacy)).toBe(false);
    const compacted = changeHistory(legacy, { compact: summary("Alice continues.") });
    expect(transcriptRecord(compacted)?.partial).toBe(true);
    expect(transcriptOf(compacted)).toEqual(legacy.history);
  });

  it("refuses a malformed record instead of rebuilding a transcript from it", () => {
    const broken = { ...session(), state: { [TRANSCRIPT_STATE_KEY]: { archived: "x" } } };
    expect(() => transcriptOf(broken)).toThrow(/transcript record is malformed/);
  });
});

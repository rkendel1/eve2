import type { ModelMessage } from "ai";

import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionStateMap } from "#harness/types.js";

export const TRANSCRIPT_STATE_KEY = "eve.transcript";

export interface TranscriptRecord {
  readonly archived: readonly HarnessModelMessage[];
  readonly projected: number;
  readonly partial?: true;
}

interface WithTranscript {
  readonly history: readonly HarnessModelMessage[];
  readonly state?: SessionStateMap;
}

export function transcriptRecord(session: {
  readonly state?: SessionStateMap;
}): TranscriptRecord | undefined {
  const record = session.state?.[TRANSCRIPT_STATE_KEY] as TranscriptRecord | undefined;
  if (record === undefined) return undefined;
  assertTranscriptRecord(record);
  return record;
}

export function transcriptOf(session: WithTranscript): readonly HarnessModelMessage[] {
  const record = transcriptRecord(session);
  if (record === undefined) return session.history;
  return [...record.archived, ...session.history.slice(record.projected)];
}

export function transcriptIsComplete(session: WithTranscript): boolean {
  const record = transcriptRecord(session);
  return record === undefined ? !startsWithCheckpoint(session.history) : record.partial !== true;
}

export function archiveForCompaction<T extends WithTranscript>(
  session: T,
  working: readonly ModelMessage[],
): T {
  const before = transcriptRecord(session);
  const record: TranscriptRecord = {
    archived: transcriptOf(session),
    projected: working.length,
    ...((before?.partial === true ||
      (before === undefined && startsWithCheckpoint(session.history))) && {
      partial: true,
    }),
  };
  return withRecord(session, record);
}

export function followHistory<T extends WithTranscript>(
  session: T,
  history: readonly HarnessModelMessage[],
): T {
  const record = transcriptRecord(session);
  if (record === undefined) return session;
  if (history.length === 0) return withRecord(session, undefined);
  const projected = projectedIn(session.history.slice(0, record.projected), history);
  if (projected !== undefined) {
    return projected === record.projected ? session : withRecord(session, { ...record, projected });
  }
  return withRecord(session, {
    ...record,
    archived: transcriptOf(session),
    projected: history.length,
  });
}

function projectedIn(
  projection: readonly ModelMessage[],
  history: readonly ModelMessage[],
): number | undefined {
  let at = 0;
  for (const message of projection) {
    while (at < history.length && !sameMessage(message, history[at])) at += 1;
    if (at === history.length) return undefined;
    at += 1;
  }
  return at;
}

function withRecord<T extends WithTranscript>(session: T, record: TranscriptRecord | undefined): T {
  const state = { ...session.state };
  if (record === undefined) delete state[TRANSCRIPT_STATE_KEY];
  else state[TRANSCRIPT_STATE_KEY] = record;
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
}

function startsWithCheckpoint(history: readonly ModelMessage[]): boolean {
  const [marker] = history;
  if (marker?.role !== "user") return false;
  const { content } = marker;
  return typeof content === "string"
    ? content === COMPACTION_CHECKPOINT_MARKER
    : content.length === 1 &&
        content[0]?.type === "text" &&
        content[0].text === COMPACTION_CHECKPOINT_MARKER;
}

function assertTranscriptRecord(record: TranscriptRecord): void {
  if (
    !Array.isArray(record.archived) ||
    !Number.isInteger(record.projected) ||
    record.projected < 0
  ) {
    throw new Error(
      `The session's transcript record is malformed: expected { archived: messages, projected: a count }. eve keeps the record and refuses to rebuild the transcript from it.`,
    );
  }
}

function sameMessage(a: ModelMessage, b: ModelMessage | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

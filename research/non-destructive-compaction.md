---
issue: "none: context management slice 2 (non-destructive compaction)"
status: implemented
last_updated: "2026-11-27"
---

# Non-destructive compaction

Rule: the transcript is authoritative. Compaction derives a working projection and never replaces history.

## Before

`session.history` was both the transcript and the array sent to the model. Compaction rewrote it to `[checkpoint marker, summary, recent tail]`, so the original messages, tool calls and tool results were gone from the checkpoint.

## Representation

`session.history` keeps its meaning: the working context, exactly what the harness sends the model. The request goldens are unchanged. The session's durable `state` gains one key:

```
state["eve.transcript"] = { archived: Message[], projected: n, partial?: true }

transcript = archived ++ history[projected:]
projection = history[:projected]     (summary and retained tail, derived from archived)
```

- **At compaction** (`changeHistory(session, { compact })`, the only compaction write), `archived` becomes the whole transcript so far and `projected` the length of the new working history. Messages appended later are part of both representations.
- **Every other history change** goes through `changeHistory`. eve follows the projection's position through insertions. If a change alters the projection itself, such as a repair, eve folds the current transcript into `archived`, so no original is lost.
- **Repeated compaction** passes the previous summary as `<previous-checkpoint>`, never as conversation. Summaries never enter the transcript.
- **Clearing** a session is an explicit request to forget, and drops the record with the history.
- **Absent record:** a session that never compacted. Its transcript is `history`.
- **Restore** reads the record back with the rest of the durable session state. The transcript is not rebuilt from event lines.

## Compatibility

A session compacted before this change has no record, and its history starts with the checkpoint marker. It restores and continues. At its next compaction, the record is marked `partial: true`, because the originals the earlier compaction replaced cannot be recovered.

## Storage

The record lives in the session checkpoint the host already stores. No new store is added. The checkpoint now grows with the conversation:

- Measured on the maintained fixture: 30 tool turns of 60,000-character results reach about 1.8 MB, against about 133 KB if only the working context were kept.
- AppBoundry `sessions@1` refuses a record over 16 MiB (`MAX_SESSION_RECORD_BYTES`) with `INVALID_ARGUMENT`.
- eve then ends the session with `WORKFLOW_EXECUTION_FAILED` and the store keeps its last accepted record. Nothing is truncated.

Sessions whose transcript approaches 16 MiB (about 4M estimated tokens) need a storage decision:

- the transcript in chunked records through a new `sessions@1` operation;
- or a raised limit.

That is not decided here.

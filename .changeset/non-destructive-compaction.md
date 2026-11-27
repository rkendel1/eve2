---
"eve": patch
---

Compaction no longer replaces a session's conversation: the model is sent the summary and recent messages, and the session's checkpoint keeps every original message, tool call, and tool result.

The checkpoint now grows with the whole conversation rather than with the compacted context, so a long session's record is larger. A store that refuses a record over its size limit, such as AppBoundry's 16 MiB `sessions@1` record, ends the session with `WORKFLOW_EXECUTION_FAILED` and keeps the last record it accepted. A session compacted by an earlier eve restores and continues; the messages that compaction already replaced cannot be recovered.

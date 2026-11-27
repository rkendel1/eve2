---
"eve": minor
---

Record what each model call was sent with a new `model.composed` session event, and read per-call composition, usage, and cache utilization with `modelCalls(events)` from `eve/events`.

`model.composed` is measured on the assembled, provider-neutral request after eve's framing, attachments, and cache markers. Its token counts are labeled estimates, broken down into system instructions, tool definitions, and history, with tool outputs and compaction summaries reported as parts of history. It also carries a prefix hash and a request hash that cover no headers, provider options, or credentials. Usage records now list the counts a provider did not report in `unreported`, so a missing cache count reads as unknown rather than zero. No model request, context policy, or caching behavior changes.

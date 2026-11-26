---
"eve": patch
---

A tool call no longer runs again after its host dies while it runs: eve now waits until the record that the call started is durable before running it.

Workflow's session stream acknowledged a write before the World committed it, so a host killed in that window lost the record that the call had started, and the retried step ran the call again. eve now waits for the stream's durability barrier after writing a call's start, and a call whose start cannot be made durable does not run. A call whose start was recorded and whose outcome was not is reported to the model as one that may or may not have taken effect, as before.

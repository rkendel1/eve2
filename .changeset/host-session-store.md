---
"eve": minor
---

`createEveHost({ store })` keeps an organization's agent's sessions in a store the host supplies, so they survive the host and continue on the same application conversation.

The store (`EveHostStore`) keeps each session's event lines and one record per session, with every write durable before it resolves. A host started on the same store restores each session at the turn, step, approval wait or idle wait it was in, and `EveHost.restoration` reports the sessions it restored and those it refused. A call that started without a recorded outcome is reported to the model as one that may or may not have taken effect, and is not run again.

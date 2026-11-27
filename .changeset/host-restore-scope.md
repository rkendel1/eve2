---
"eve": minor
---

`createEveHost({ restore: { connection } })` restores and serves one application conversation, so a host that runs a separate instance per conversation never resumes another conversation's work.

Without `restore`, a host still restores every stored session. With it, only the session of that conversation is restored; every other stored session is left as it was. `connect` refuses any other conversation, so the host never starts a second session for a conversation it did not restore. A refused checkpoint is reported in `EveHost.restoration` and left unchanged.

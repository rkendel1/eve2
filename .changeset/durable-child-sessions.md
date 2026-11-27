---
"eve": patch
---

On an in-process host with a durable store, an agent tool's child session and its parent's pending call now survive a process restart: the call settles once with the child's actual result, without re-sending the child's input.

Child sessions are now saved with their parent as their root, and a scoped restore also restores the sessions rooted in what it restores. When a parent is restored, its open agent tasks re-attach to their existing children from the parent's recorded facts, or from the child's own record. A task whose child can't be found fails explicitly instead of starting a new child. The session program also saves a checkpoint after applying a background run message, so a settlement isn't lost to a later restart. Workflow behavior is unchanged.

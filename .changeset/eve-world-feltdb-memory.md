---
"@appport/eve-world-feltdb": minor
---

`feltdbWorldMemory()` stores an agent's `fileMemory` documents in FeltDB beside the FeltDB World.

Use `fileMemory({ backend: feltdbWorldMemory() })` in an agent that runs on `@appport/eve-world-feltdb`: it opens `<EVE_FELTDB_PATH>/memory` once per process with the World's transaction-id retention, so memory no longer needs local files.

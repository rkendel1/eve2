---
"@appport/eve-world-feltdb": minor
---

`createWorld()` now waits for a killed host's lock on its directory to clear, so a restarted host takes its sessions over instead of failing with `STATE_LOCKED`.

`createWorld()` returns a promise. It retries FeltDB's `STATE_LOCKED` for up to `EVE_FELTDB_OWNER_WAIT_MS` (default 15 seconds), then fails; a directory held by a live or paused process is still refused. eve accepts the promise as it is; a caller that uses the World directly must await it.

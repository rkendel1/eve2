---
"eve": minor
---

Add `localFiles()` to `eve/memory/file`, a durable local-disk backend for `fileMemory()` on a self-hosted `eve start` server.

Writes are atomic and reject stale versions within one server process. Use one process per directory, and a shared backend for replicas. `fileMemory()` without a backend still requires one outside Vercel and `eve dev`; its error now names `localFiles()`.

---
"eve": patch
---

`EveHost.idle()` and `dispose()` now wait for the host's store writes, so a store whose writes take time no longer lets `idle()` resolve before a restored session's checkpoint is written.

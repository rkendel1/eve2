---
"eve": minor
---

eve CLI telemetry is now off by default and honors `DO_NOT_TRACK`; run `eve telemetry enable` to opt in.

Machines that never changed the setting stop sending CLI usage data to Vercel. A saved `eve telemetry enable` keeps telemetry on.

---
"eve": patch
---

Fix tracers obtained before `registerOTel()` staying silent: eve's vendored packages share one copy of the OpenTelemetry API again.

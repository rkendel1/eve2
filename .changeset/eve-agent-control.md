---
"eve": minor
---

Add `control` to `defineAgent` so a host can hold a session's turns at model and tool boundaries, resume them with the new `resume` session command, and deliver people's updates to the model.

A held turn records `turn.held` on the session stream and waits durably, across restarts, for `POST /eve/v1/session/:sessionId/resume` (`session.resume()`), then asks the control again. Instructions a checkpoint returns reach that model step once as user messages and are acknowledged after the step succeeds. Agents without `control` behave as before.

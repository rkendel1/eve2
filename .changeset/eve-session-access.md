---
"eve": major
---

The eve channel now gives a session only to the caller that created it: knowing a session ID no longer lets anyone else read, message, answer, or control it.

Every session route (`POST /eve/v1/session/:sessionId`, its `cancel`, `compact`, `clear`, `resume`, `end` and `reset` routes, and the `stream`, `descendants/stream`, `subagents/…/stream` and `stubs` routes) checks the caller against the session's owner before it reads or acts, and answers anyone else exactly as for a session that doesn't exist: `409 session_not_active` on message and control routes, `404 session_not_found` on stream routes. The owner is the identity the channel's `auth` returned when the session was created, recorded with the session so the check holds after a restart.

To share sessions on purpose, pass `eveChannel({ sessionAccess })`. It decides each request from the caller, the operation (`read`, `message`, `respond`, `control` or `prepare`) and whether the caller is the owner, and runs on every request, so revoking access takes effect at once. Access to a session doesn't make someone an approver; approval response policies still decide that.

Migration: sessions started by an earlier eve version, and sessions an anonymous caller started, have no owner and are refused to everyone. Admit them from your own records with `sessionAccess`. A public demo that uses `none()` and lets anyone with a session ID continue it can pass `sessionAccess: () => true`. Clients that read or continued another caller's sessions, for example a service that relays for several users, must create the sessions they use or be admitted by `sessionAccess`.

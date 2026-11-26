---
issue: "none: EVE principal-bound session access milestone (no tracking issue yet)"
status: proposed
last_updated: "2026-11-26"
---

# Principal-bound session access

A session ID identifies a session. It must not grant authority over it. Today the eve channel's session routes check
only route auth (may this caller use the channel?) and then act on whatever session the path names. Any caller that
passes route auth, and knows or guesses an ID, can read another person's history, message their session, answer their
requests, and cancel or end it. An approval policy refuses a stranger's answer, but only after the channel accepted
the delivery. The docs state this as the contract: forwarding "doesn't make a child session private… check ownership
in your application" (`docs/guides/remote-agents.md`).

eve already binds work to its caller elsewhere. The `work` and A2A channels stamp `$eve.invocation_owner`, a SHA-256 of
`principalIdentity(auth)` (authenticator, issuer, principal type, principal ID, subject), on the run when it starts, and
answer any other caller exactly as for unknown work (`internal/invocation/owned-run.ts`). This plan extends that
contract to the eve channel instead of adding a new identity system.

## API

```ts
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [myAuth()],
  sessionAccess: ({ caller, operation, owner, sessionId }) =>
    owner || grants.allows(sessionId, caller, operation), // the application's own, current records
});
```

- **Default.** Only the caller that created a session may use it. Without `sessionAccess`, a caller is admitted when its
  identity matches the session's owner.
- **`sessionAccess`.** Replaces the default for every session route and runs on every request, so it reads the
  application's authoritative records and a revocation applies to the next request. It receives the authenticated
  `caller`, the `operation`, whether the caller is the `owner`, and the `sessionId`. It is never asked about a session
  that does not exist.
- **Operations.** `read` (stream, descendant and subagent streams, tool stubs), `message`, `respond` (answers to
  approvals and questions), `control` (cancel, compact, clear, resume, end, reset) and `prepare`.

## Semantics

- **Owner.** The authenticated route caller of the create request. With a trusted forwarder, that is the forwarder,
  which already may assert any identity; the forwarded user still runs the turn. Anonymous callers own nothing: a
  session an anonymous caller starts can be continued only through `sessionAccess`.
- **Children.** A subagent's session has no owner of its own; access follows its root session.
- **Denial is indistinguishable from absence.** An unknown session and a refused caller go through one branch and get
  the same response: `409 session_not_active` on message, respond, prepare and control routes (the documented response
  for an unknown session), `404 session_not_found` on read routes, and the subagent route's own `404`.
- **Session access is not approval authority.** A caller admitted to `respond` still faces the tool's approval
  response policy, which by default accepts only the requester.
- **Durability.** The owner key is a reserved run attribute (`$eve.session_owner`) written atomically with the run, so
  it exists before the create request returns, survives the death of the host, and needs no checkpoint change
  (`SESSION_CHECKPOINT_VERSION` stays 19). The in-process runtime (`eve/experimental/host`, Node and Boa) records the
  same key with its session.
- **Sessions without a binding** (started before this change, by another channel, or by an anonymous caller) are
  refused to everyone unless `sessionAccess` admits them. That is the recovery path: an application that knows who
  owns its legacy sessions admits them from its own records.

## Boundaries

- The check sits in the eve channel, before any route reads or acts. Body validation that does not depend on the
  session still answers first. Custom channels built with `defineChannel` own their routes and their checks.
- Token-addressed routes (run callbacks, OAuth connection callbacks, Workflow webhooks) are capabilities by design and
  are unchanged.
- FeltKit, which serves sessions to everyone in a workspace, keeps that rule in FeltKit: it signs a `session` claim on
  requests it has authorized against its own records, and `feltkitSessionAccess()` admits the owner or that claim.

## Out of scope

Multi-host execution, general-purpose RBAC, organization membership, and changes to approval policies.

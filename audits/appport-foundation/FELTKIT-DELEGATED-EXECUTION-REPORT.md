# FeltKit delegated on-behalf-of execution over `/appport`

This is Slice 2.0 of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

| Repository                                         | Branch                         | Change                        |
| -------------------------------------------------- | ------------------------------ | ----------------------------- |
| `rkendel1/feltkit` (from `04d307f`, now `fca9fcb`) | `claude/dreamy-galileo-4z03p5` | The contract (primary change) |
| `rkendel1/eve2` (from `ec3d174`)                   | `claude/dreamy-galileo-4z03p5` | Consumer                      |

**Result.** An agent authenticated by its own FeltKit session can invoke a person's published FeltKit capability for that person when AuthBoundry allows it. The decision is made as that agent, proven by its own credential, through a delegation the person gave it for exactly that capability. The function runs as the person. FeltKit's audit record names the person, the agent, and AuthBoundry's decision and delegation.

The following are all refused before the function runs and before AppPort claims an idempotency key:

- a forged person;
- a missing, revoked or insufficient delegation;
- another agent's grant;
- another person's grant;
- an undelegable or approval-required capability.

The real eve agent uses this path end to end, including a crash of both eve and FeltKit.

Personal OS was not changed.

## What existed (inspected)

| Piece                     | Where                                                             | What it already did                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/appport` authentication | FeltKit `server/index.ts` `createAppPortServer({ authenticate })` | Session token, API key, or the app's `authenticate` hook → AppPort principal. Agents are a principal type (`feltkit session create --type agent`)                                                                                                 |
| AppPort dispatch          | `@appport/core` `application.js:299-330`                          | **validate input → authorizer → idempotency claim → handler**. So an authorizer refusal leaves no claim and runs nothing                                                                                                                          |
| FeltKit's authorizer      | `runtime.ts` `observationAuthorizer(permissionAuthorizer)`        | Roles → permissions of the authenticated principal                                                                                                                                                                                                |
| AuthBoundry decision      | `application-authority.ts`, `authboundry.ts`                      | `ctx.authority.decide({ capability, onBehalfOf })`. Fails closed unless the allow echoes the application, principal, capability, `on_behalf_of` and `delegation_id`                                                                               |
| Per-agent delegation      | `local-authority.ts` `agentDecision`, `agentsFor`, `grantsFor`    | An agent **caller** decides only as itself with its own credential, held in FeltKit custody. AuthBoundry proves it (`executor.proven`, `method: agent_credential`). Operators register agents; people grant an agent capabilities, only their own |
| Idempotency               | `runtime/idempotency.ts` (FeltDB), `replayKey`                    | Keys scoped by session id or principal                                                                                                                                                                                                            |
| Audit                     | `runtime/audit.ts`                                                | One record per committed mutation, in the mutation's transaction: principal, `authority` and writes                                                                                                                                               |
| Personal OS `actingFor`   | `personalOS/feltkit/_ops.ts:36`                                   | A function-local "work for this owner" view, used only after a surface link was verified. It is not an identity, and FeltKit had no on-behalf-of identity                                                                                         |

**The gap.** All the pieces existed, but `/appport` had no way to say "this agent, for this person". An agent calling a published function ran as itself.

**Can AuthBoundry establish the relationship at the FeltKit boundary safely? Yes, with existing contracts.** A decision asked _as the agent_ (proven by its credential) _on behalf of_ a person allows only if that person delegated that capability to that agent. So the person named in the request is a selector that AuthBoundry either confirms through a delegation, or refuses. An agent naming an arbitrary person learns nothing beyond a refusal.

## Authentication and delegation flow

```
agent ──POST /appport──────────────────────────────▶ FeltKit server
  Authorization: Bearer <agent session>       1. session → principal {id: scribe, type: agent}
  X-AppPort-On-Behalf-Of: ada                 2. header accepted only from an agent session,
                                                 only a plain id; else 403 / 400
                                              3. AppPort: validate input
                                              4. authorizer (delegated):
                                                 a. a published function, listed in
                                                    authority.capabilities, not approval-required
                                                 b. person = ada as she is now (account or identity; a user)
                                                 c. AuthBoundry check as agent:scribe, proven by its
                                                    custody credential, on_behalf_of user:ada,
                                                    capability notes.add
                                                 d. exact allow? (agent, proof, person, capability,
                                                    decision id, delegation id)
                                                 e. ada's own roles hold the capability's permission?
                                              5. idempotency claim (scope: agent session + ada)
                                              6. function runs as ada; ctx.auth.delegation set
                                              7. audit record in the mutation's transaction
```

| Identity             | Established by                                                                                                                             | Caller-controlled? |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Agent                | FeltKit session token, operator-issued, type `agent`                                                                                       | No                 |
| Agent at AuthBoundry | AuthBoundry, by the agent's own credential in FeltKit custody (`executorProof.proven`)                                                     | No                 |
| Person               | Named in the header; **accepted only from AuthBoundry's allow** echoing `on_behalf_of` and a delegation id; then resolved as the live user | Only as a selector |
| Delegation           | AuthBoundry's `delegation_id`, for exactly this agent, person and capability                                                               | No                 |

## Trusted execution context

```ts
ctx.auth.principal   // the person: { id: "ada", type: "user", roles: [her roles now] }
ctx.auth.delegation  // null for a direct call, otherwise:
{ agent: "scribe", agentAuthority: "agent:scribe", person: "ada", onBehalfOf: "user:ada",
  capability: "notes.add", decisionId: "…", delegationId: "…", authorityMode: "local-per-agent" }
```

**Who can set it.** Only the authorizer, into the request's `AsyncLocalStorage` scope, after verification. The handler refuses a delegated request without a verified delegation for this exact capability. `runtime.call` refuses one whose principal is not the verified person, or whose function needs approval. Nothing in the input, the header or the model reaches it.

**Code** (FeltKit):

| File                                          | Change                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/delegation.ts` (new, 98 lines)       | The header name, the person selector, the per-person idempotency scope, and `verifyDelegation`                                            |
| `runtime/runtime.ts`                          | The delegated authorizer around the existing one; the person resolver; the handler and `#call` checks; the `CallOptions.delegation` field |
| `server/index.ts`                             | Header admission, plus the delegated session scope in `authenticate`                                                                      |
| `runtime/authority.ts`, `runtime/activity.ts` | The `ctx.auth.delegation` field and the authority-record type                                                                             |

The FeltKit diff is +168 / −10 lines across six files, plus `delegation.ts`, a test and its fixture. It adds no new store, authorization service or framework.

## Provenance and idempotency

**Audit (durable, transactional).** `authority.delegation` is on the record. `authority.appportDecisionId` equals AuthBoundry's `decisionId`. The principal is the person, and `via` is `appport`. A direct call's record has no `delegation`.

**Other records:**

- **AuthBoundry decision record:** `authority.decide` in the activity log, with decision and delegation ids, executor proof and authority mode.
- **AppPort's `authorizationDecision`:** returned to the agent, with `authorizer: "authboundry"` and `evidenceId` set to the delegation id.

**Idempotency.** It is FeltKit's existing FeltDB store, unchanged; the only addition is the scope. A delegated session id is `dlg_` + SHA-256(agent session, person), so the same key from the same agent for two people never replays one person's response to the other.

**Found in passing.** Without that scope, AppPort keys the agent's session alone, and the same key would replay Alice's stored response to Bob. A mutation check confirms the test catches it.

## Negative security evidence

FeltKit `test/delegated-appport.test.ts` uses a real HTTP server, the real AuthBoundry server through `@authboundry/local` 0.1.1 with core 1.20.0, and FeltDB. Each refusal also asserts that the function **did not run**: the handler logs every entry, and the log is unchanged.

| #    | Requirement                            | Observed                                                                                                                                                                                                                             |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Direct user unchanged                  | Ada adds and lists her notes; `delegation` is null                                                                                                                                                                                   |
| 2, 3 | Delegated read, the person's data only | With Ada's `notes.list` grant to Scribe: Scribe lists Ada's notes only (Grace's exist); `owner = ada`; the delegation carries the grant id                                                                                           |
| 4    | No delegation                          | 403, function not run                                                                                                                                                                                                                |
| 5    | Another person's grant                 | Grace's `notes.add` grant to Scribe does not let it add as Ada; Grace's list returns Grace's notes only                                                                                                                              |
| 6    | Forged identity                        | Ada's own session naming Grace: 403. `user:grace`, `agent:scribe`, an empty value or a list: 400. The agent without a header acts as itself and holds nothing: 403. An extra `owner` input field: refused (`INVALID_INPUT`), not run |
| 7    | Read grant cannot write                | 403, not run                                                                                                                                                                                                                         |
| 8    | One capability is not another          | `notes.remove` (not granted), `notes.count` (published, not in `authority.capabilities`) and `notes.publish` (granted, but approval-required): all 403, not run                                                                      |
| —    | Delegation cannot exceed the person    | Guest (viewer) granting `notes.add`: 403                                                                                                                                                                                             |
| —    | Another agent, or an unregistered one  | Rival with Ada's grant to Scribe: 403; Stranger (never registered): 403                                                                                                                                                              |
| 9    | Revocation                             | Allowed before; after Ada revokes, 403, not run                                                                                                                                                                                      |
| 10   | Provenance                             | One audit record: principal ada (`user`), `via` appport, delegation agent scribe, the grant id, AppPort decision id = AuthBoundry decision id; the write is listed; the note carries `addedBy: scribe`                               |
| 11   | Repeat with the same key               | Identical output, one note. The same key for Grace gives Grace's own note, never Ada's response                                                                                                                                      |
| 12   | Restart                                | Runtime and server closed and restarted on the same FeltDB and AuthBoundry state: the key replays, the handler is not re-entered, and no new audit record                                                                            |
| 13   | Direct versus delegated                | The direct record has no delegation; the delegated record has one                                                                                                                                                                    |

**Mutation checks** on that test. Each was applied, run and restored.

| Mutation                                                                              | Result                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorizer ignores AuthBoundry's refusal                                              | **Caught** ("no delegation" allowed)                                                                                                                                                              |
| Idempotency scope per agent, not per person                                           | **Caught** (Grace got Ada's stored response)                                                                                                                                                      |
| Approval-required functions allowed                                                   | **Caught**                                                                                                                                                                                        |
| "Only an agent may name a person" guards removed (header, `authenticate`, authorizer) | Not caught. AuthBoundry's proof still refuses: a non-agent caller is decided as the application's executor, never as a proven agent, so `verifyDelegation` refuses. The guards are a second layer |
| Person-role check in the authorizer removed                                           | Not caught. `runtime.call` re-checks the person's roles before the handler. The authorizer check exists so refusal happens before AppPort's idempotency claim                                     |

## Destination integration

`examples/appport-agent/test/feltkit.test.mjs` runs:

- real `eve start` with the scripted model;
- a real **FeltKit server process** (`test/feltkit-host.mjs`, from the FeltKit checkout named by `FELTKIT_SDK_DIR`), with its private AuthBoundry and FeltDB on disk.

The agent's credential file holds its FeltKit agent session. `APPPORT_ON_BEHALF_OF=subject` names the person by the verified requester token's subject.

| Case                                                                         | Observed                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alice's delegated add and list                                               | Work completed; FeltKit returns `owner: alice`, `agent: appport-agent`. Alice's direct read shows `["A1"]` and no agent                                                                                         |
| Bob (no grant) and Carol (read-only grant) adding                            | Work blocked; operation `failed`, `FORBIDDEN`                                                                                                                                                                   |
| Bob's own session naming Alice                                               | `FORBIDDEN`                                                                                                                                                                                                     |
| eve killed after FeltKit applied A2, then FeltKit killed too; both restarted | Work completed; operation `succeeded` on attempt 2 with the same key; exactly one A2                                                                                                                            |
| Alice revokes                                                                | Next work `FORBIDDEN`; notes unchanged                                                                                                                                                                          |
| FeltKit audit, read with the server stopped                                  | Exactly two `notes:add` records, each principal alice (`user`), via appport, delegation agent `appport-agent`, AuthBoundry decision id = AppPort decision id, with a delegation id. Bob and Carol have no notes |
| Model tools                                                                  | Still only the three AppPort tools; the model has no way to name a person                                                                                                                                       |

**Destination changes:**

- `agent/lib/appport.ts`: the `APPPORT_ON_BEHALF_OF=subject` mapping, off by default.
- The scripted fixture model: a `List via` step.
- The FeltKit host harness and the test.

Operation safety, reconciliation and settlement were not touched.

## Test commands and results

| Command                                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FeltKit: `node --import tsx --test test/delegated-appport.test.ts`                                   | **1 of 1** (13 required cases and the negatives above)                                                                                                                                                                                                                                                                                                                                               |
| FeltKit: `node --import tsx --test test/local-authority.test.ts`                                     | 3 passed, 1 skipped (it needs an `@authboundry/local` _without_ per-agent delegation)                                                                                                                                                                                                                                                                                                                |
| FeltKit: full `node --import tsx --test --test-concurrency=1 test/*.test.ts` (after `npm run build`) | 796 tests: 768 passed, 25 failed, 3 skipped. Every failure is in a build, deploy, platform or production file (`components`, `credential-custody`, `deploy`, `dev`, `fly`, `platform-changes`, `platform-deployments`, `platform-exec`, `platform-large-state`, `services-released`); the first one reads "Both FELTDB_URL and FELTKIT_STATE_DIR are set for production". Baseline comparison: below |
| FeltKit: `tsc -p tsconfig.json --noEmit`                                                             | Clean                                                                                                                                                                                                                                                                                                                                                                                                |
| eve2: `FELTKIT_SDK_DIR=… node --test test/feltkit.test.mjs`                                          | **7 of 7**                                                                                                                                                                                                                                                                                                                                                                                           |
| eve2: `node --test test/` (full destination suite)                                                   | **91 of 91** with `FELTKIT_SDK_DIR` set (84 earlier tests and the 7 FeltKit tests); the real-model block is skipped (no key)                                                                                                                                                                                                                                                                         |

**Not run:**

- FeltKit's `vitest` conformance suite (`test:conformance`) and its examples and e2e;
- Personal OS's tests;
- the destination's real-model acceptance tests (no key in this environment).

## Remaining limitations

- **Local authority only.** With a hosted AuthBoundry, FeltKit holds no agent credentials, so nothing is proven as the agent and every on-behalf-of call is refused. A hosted equivalent needs the agent to present its own AuthBoundry credential, which FeltKit would forward (`x-authboundry-agent-credential`); not built.
- **Opt-in per capability** through `authority.capabilities`. Personal OS lists only its `personalos.*` surface vocabulary today, so 2a must add the published names it will delegate.
- **Personal OS's action log** records `me(ctx)` and `via`, not the agent. 2a should read `ctx.auth.delegation`.
- **Integration operations and `approval: "required"` functions** are not reachable on a person's behalf. MCP (`/mcp`) does not read the header.
- **Tenancy is not carried.** The person runs without a workspace, so tenant-scoped capabilities are untested and likely refused.
- **Input is validated before the delegation is decided.** AppPort's input gate is synchronous and the decision needs AuthBoundry. The input contract is public in the manifest anyway.
- **One AuthBoundry round trip per invocation.** Revocation applies at once; nothing is cached.
- **Person ids are shared.** The destination maps a requester to a FeltKit person by token subject, which assumes the requester issuer and the application share ids. Real identity linking is a later slice.
- **A disabled account** is refused by construction, but that case is not tested here; the dev users were used.
- **The destination test depends on a FeltKit checkout** until a FeltKit release includes this change. It skips with a message otherwise.

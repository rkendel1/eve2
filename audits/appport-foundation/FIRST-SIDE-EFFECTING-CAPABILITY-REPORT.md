# eve + AppPort: first side-effecting capability

Branch `claude/dreamy-galileo-4z03p5`, building on `3db6914`. This is milestone 2 of the original roadmap.

**Result:** a person delegates `catalog.reserve` to the eve agent through AuthBoundry. eve reserves real inventory through AppPort as a durable operation. The resulting stock and reservation can be read independently and are traced to that person's delegation. Interrupted executions never duplicated the effect and never reported an uncertain outcome as success.

## Phase 1: choosing the capability

| Candidate                            | Where                                        | Why not used                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.mutate`, `world.reset`        | `rkendel1/appport/examples/world`            | Private example; `authorization: []` (public); no `effect` or `idempotency` declared; in-memory simulation                                                                                                                                                                                                                         |
| `invoices.create`                    | `appport/examples/agent-feedback/example.ts` | An illustration inside an example script                                                                                                                                                                                                                                                                                           |
| `appport.feedback.submit`            | `@appport/sdk`                               | Real and idempotent, but advisory API feedback, not an action a person delegates                                                                                                                                                                                                                                                   |
| `resolver.put` / `resolver.revoke`   | `@appport/resolver` 0.4.0                    | Real, conditional (`expectedRevision`), reversible and readable (`resolver.resolve`). But `createResolverApplication` hard-wires API-key authentication and its own `permissionAuthorizer`, and declares no idempotency. AuthBoundry delegation and the durable idempotency store **cannot be applied without modifying Resolver** |
| personalOS `tasks.create` and others | `personalOS/feltkit`                         | FeltKit operations, not AppPort capabilities                                                                                                                                                                                                                                                                                       |

**Gap:** no existing AppPort capability in the ecosystem accepts a host-supplied authorizer and idempotency store. **Choice:** add one capability, `catalog.reserve@1`, to the existing inventory application. Its effect is testable (stock and reservation), observable (`catalog.lookup`, `catalog.reservation`) and reversible by an operator.

**Stack-Agent compared with the eve ledger** (`rkendel1/stack-agent` at `c066006`):

| Stack-Agent                                                                      | eve ledger before this slice                    | Disposition                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Intent recorded before dispatch (`begin`)                                        | `prepared` → `executing`                        | Already covered                                                                    |
| An open intent is never repeated (`OutcomeUncertain`)                            | Stale `executing` with no key → `indeterminate` | Already covered                                                                    |
| `reconcile`: ask the destination; resolve only on sufficient evidence (`decide`) | Missing                                         | **Reused**: `decide` ported unchanged in semantics                                 |
| `Reconciler` trait (destination `status` + `verify`)                             | —                                               | **Small adaptation**: one AppPort read capability answers both, in the same shapes |
| Every query recorded (`chip.Reconciliation`)                                     | —                                               | Adapted: `reconciliations[]` on the operation record                               |
| Task leases, FeltDB plumbing, `chip.*` records (Rust)                            | eve, FeltDB and the ledger                      | Not ported                                                                         |

## What was built

| File                         | Lines | What                                                                                                                                                                                                             |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appport-host/inventory.mjs` | 140   | Inventory state in FeltDB. A reservation is one transaction (stock compare-and-set plus a create-if-absent reservation keyed by the scoped idempotency key). Operator `release`                                  |
| `appport-host/host.mjs`      | +124  | `catalog.reserve@1` (consequential, `idempotency: "supported"`, needs `catalog.reserve`, refuses a missing key); `catalog.reservation@1` (read, Stack-Agent reconciler shape); `catalog.lookup` reads live stock |
| `agent/lib/reconcile.ts`     | 68    | Port of Stack-Agent's `decide` table                                                                                                                                                                             |
| `agent/lib/operations.ts`    | +148  | Reconciliation of stale or indeterminate operations through a configured read (`APPPORT_AGENT_RECONCILERS`)                                                                                                      |

**What the existing platform handled with no new code:**

- **AuthBoundry:** delegation check, revocation, and the `delegation_id` passed through AppPort's `authorizationDecision`.
- **AppPort:** schema validation, durable idempotency claims and replay, and the manifest that declares effect and idempotency.
- **eve:** the operation ledger (intent, identity, conflict, retry rules), durable work, crash recovery of turns, and evidence citations.
- **FeltDB:** atomic multi-record transactions and conditional writes.

## Phase 3: evidence

`test/reserve.test.mjs` runs real eve (`eve start`, scripted model), the AppPort host **as its own process**, AuthBoundry and FeltDB. eve and host crashes kill process groups; restarts start new processes on the same stores. State is checked with AppPort reads (`catalog.lookup`, `catalog.reservation`) while running and with direct FeltDB reads when stopped.

| #   | Requirement                                | Observed                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authorized user performs the operation     | Alice's work completes; ALPHA-1 42 → 40; `catalog.reservation` reports committed and present for her operation's key                                                                                                                                      |
| 2   | No delegation: rejected before the effect  | Bob (read-only grant): `FORBIDDEN`, `delegation_missing`; stock unchanged; nothing applied                                                                                                                                                                |
| 3   | Revocation stops later execution           | Carol reserves, then her delegation is revoked (host restarted with the revocation); her next request gets `delegation_revoked`; stock unchanged                                                                                                          |
| 4   | Forged credential                          | `UNAUTHORIZED`; stock unchanged                                                                                                                                                                                                                           |
| 5   | Repeated request                           | One operation, **one AppPort request**, one reservation                                                                                                                                                                                                   |
| 6   | Concurrent duplicates                      | 5 concurrent requests with one key: one reservation id, **one handler execution**                                                                                                                                                                         |
| 7   | Crash before invocation                    | eve killed after `prepared`: stock unchanged; after restart, completed once (42 → 39 overall)                                                                                                                                                             |
| 8   | Crash after the effect, before the outcome | eve killed after AppPort answered: the reservation exists. After restart the model re-issued the call; the ledger **reconciled by reading** (`finding: completed`) and did not dispatch; stock decreased once                                             |
| 9   | Host restart preserves idempotency         | Host killed after the effect, before its response was stored: the work is indeterminate. After a real host restart, a retry with the operation's key gets `IDEMPOTENCY_OUTCOME_UNKNOWN`; stock unchanged; reconciliation then established it as completed |
| 10  | Indeterminate stays indeterminate          | Host killed after the claim, before the effect: no reservation. Every reconciliation (≥ 2 passes) finds "not applied, not barred" → `indeterminate`; stock unchanged; AppPort still refuses to re-run                                                     |
| 11  | Provenance chain                           | Every succeeded operation maps to one reservation carrying the same person, `agent:appport-agent`, the person's AuthBoundry delegation id and the operation's key. Host provenance links each request to its decision and work trace id                   |
| 12  | External state matches recorded outcomes   | For both SKUs, stock = initial − held reservations and `reserved` = their sum. Succeeded operations have exactly one reservation; failed and indeterminate operations have none                                                                           |

The same final test releases a reservation through the operator function, and stock is restored.

**Real model.** In `acceptance.test.mjs`, Claude was given "Please reserve 2 units of SKU BETA-2 for me." It produced one `catalog.reserve` operation, `succeeded`; BETA-2 dropped by exactly 2; and the AppPort decision carries Alice's grant id.

**Runs:**

| Run                                  | Result                                |
| ------------------------------------ | ------------------------------------- |
| Reserve suite                        | 11 of 11                              |
| Decision-table test                  | 11 of 11 rows                         |
| Acceptance suite with the real model | 17 of 17                              |
| Full suite with the real model       | **77 of 77**: six files, concurrently |

The key appeared 0 times in the logs, and no processes were left running.

**Mutation checks**, each on the reserve suite:

| Mutation                                 | Targeted test caught it                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| Host ignores AuthBoundry's decision      | Bob rejected (plus a cascade from the stray reservation) |
| Host accepts any agent credential        | Forged credential rejected                               |
| Ledger re-sends a settled operation      | Repeat request: one AppPort request (alone)              |
| Store lets an abandoned claim run        | Host crash after the effect                              |
| Reconciler treats "not barred" as barred | Host crash after the claim stays indeterminate           |

## Phase 4: assessment

**Reused from Stack-Agent:** the reconciliation decision model. That covers `decide`, the two-question reconciler contract, the rule that a missing record is not proof, and recording every query.

**Not reused:**

- Rust execution;
- task leases (eve and FeltDB's single writer already hold that role);
- the `begin`/`settle` machinery (the eve ledger already does it).

**Remaining platform gaps:**

- **Resolver** can't take a host authorizer or idempotency store, which is why it wasn't the capability used here.
- **AppPort's manifest** has no way to declare a capability's reconciler, so it's operator configuration (`APPPORT_AGENT_RECONCILERS`).
- **AppPort reports** a live claim and an abandoned one identically.
- **The published `@appport/client`** drops `authorizationDecision`, so the delegation id is read from host provenance and the reservation, not the response.

**Operational limitations:**

- **One host per store.** The inventory and idempotency stores are FeltDB local file stores held by one host process; a second host is refused.
- **No barring.** The host does not bar an abandoned key, so a claim that died before its effect can never be proven not-executed. It stays `indeterminate` for a person to resolve, which is the next roadmap milestone.
- **The AuthBoundry orphan defect** still needs control-group supervision.
- **No retention** for reservations or idempotency records.
- **Reconciliation independence is limited.** The destination's operation record and the business effect come from the same transaction. The business check re-reads the item's reserved total, but both facts come from one host.

**Is `catalog.reserve` safe to expose through a hosted agent?**

Within what was tested, yes:

- authority comes from the person's revocable delegation;
- the effect is atomic, keyed and reversible by an operator;
- repeats and crashes did not duplicate it;
- uncertain outcomes stay visible.

It is not yet safe for unattended use at scale, for three reasons:

- indeterminate operations need a person and no resolution path exists;
- there is no rate or quantity limit beyond available stock;
- a single host is a single point of failure.

## Observed versus inferred

**Observed:** everything in the evidence table, plus the real-model reservation.

**Inferred, not tested:**

- behavior with several AppPort hosts;
- FeltDB server runtimes;
- real providers' retry behavior beyond the one real-model run;
- long-delayed reconciliation.

**Not claimed:** exactly-once effects beyond this host. A reservation is applied at most once per key while the host's stores survive. That rests on FeltDB's transaction and AppPort's durable claim, both tested across real restarts.

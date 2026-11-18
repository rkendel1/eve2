# Capability port backlog

This is derived from [`CAPABILITY-INVENTORY.md`](CAPABILITY-INVENTORY.md). The backlog is ordered for working through **one slice at a time**. Each slice is a coherent outcome, not a list of capabilities. Nothing here is implemented yet.

**Ranking criteria, in order:**

1. It completes a safety boundary the destination already relies on.
2. It is used in core workflows today.
3. It is reused across products.
4. An implementation with tests already exists.
5. It fills a real AppPort gap.
6. Its security and operational cost is proportionate.

**Categories:**

| Code | Category               |
| ---- | ---------------------- |
| CORE | Core agent             |
| POS  | Personal OS            |
| EXT  | External integrations  |
| ADM  | Administrative         |
| INT  | Internal orchestration |

## Sequence

```
1 Operator settlement (ADM) ──────────────────────────────┐
2 Delegated Personal OS capabilities (POS)                │
   ├─ 2.0 on-behalf-of path on FeltKit /appport (prereq)  │
   ├─ 2a tasks, reminders, briefing                       │
   ├─ 2b memory                                           │
   └─ 2c projects, documents                              │
3 Research runs (POS) ── needs 2.0                        │
4 Runtime safety mechanisms (INT) ── independent ─────────┤
5 Identity linking (EXT) ── needs 2.0                     │
6 AnywhereAide integration (EXT) ── needs 2.0 and 5        │
7 voice-agent delegated tools (EXT) ── needs the 2.0 pattern
8 Contract-verified replacement (CORE) ── needs 4 (pinning)
```

Slices 1 and 4 have no dependencies and can be done at any time. Slice 2.0 gates slices 2, 3, 5 and 6.

---

## 1. Operator settlement of indeterminate operations (ADM). **Done:** [OPERATOR-SETTLEMENT-REPORT.md](OPERATOR-SETTLEMENT-REPORT.md).

**Why first.** The last milestone left operations that cannot be proven applied or not applied as `indeterminate`, with no path to resolve them. That is the blocking reason `catalog.reserve` is not safe for unattended use. This slice is small, has a complete tested source implementation, and finishes a safety boundary rather than adding surface.

|                 |                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source to reuse | stack-agent SA-20: `chip-agent-state/src/lib.rs:1737 settle`, CLI `agent_state_cmd.rs:1045`, tests `chip-agent-state/tests/settlement.rs` and `serve_settle.rs`                                                                                                                      |
| Destination     | An operator-only settle action on the existing operation ledger (`agent/lib/operations.ts`): `indeterminate` → `succeeded` or `failed`, write-once, carrying operator identity, the reason and the evidence reference. **Not** a model-facing tool and **not** an AppPort capability |
| Services        | The existing FeltDB ledger. No new store                                                                                                                                                                                                                                             |
| AuthBoundry     | Operator identity is authenticated. Settlement is an administrative authority distinct from any delegation the agent holds; the agent's own credential must not be able to settle                                                                                                    |
| Provenance      | The settlement record is appended to the operation (who, when, outcome, reason, evidence) and never overwrites reconciliation history                                                                                                                                                |
| Gaps            | Barring an abandoned AppPort key (so "not applied" becomes provable) is an AppPort host concern and stays out of scope                                                                                                                                                               |

**Acceptance:**

- [x] An operation stuck in `indeterminate` (test 10 of the reserve suite) is settled by an operator, and work completion reflects the settled outcome.
- [x] A second settlement of the same operation is refused.
- [x] Settling a non-indeterminate operation is refused.
- [x] The agent's own credential, and the model through any tool, cannot settle.
- [x] Settlement survives eve restart, and the record shows the operator, the reason and the prior reconciliations.
- [x] A settled `failed` operation is never re-dispatched with the same key.

## 2. Delegated Personal OS capabilities (POS)

**Why.** Personal OS is the main product consumer. Seven of its capabilities are already published on FeltKit's `/appport` (PO-06–11, 13, 14, 17, 20, 25), so most of this is _making the existing contracts delegable_, not porting code. They are core daily workflows and the model tools already exist in Personal OS (`feltkit/turn.ts:28`).

### 2.0 Prerequisite: on-behalf-of on FeltKit `/appport`. **Done in FeltKit:** [FELTKIT-DELEGATED-EXECUTION-REPORT.md](FELTKIT-DELEGATED-EXECUTION-REPORT.md)

|                 |                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gap             | The 13 published functions authorize by the caller's own FeltKit session. An agent calling them acts as itself, not for the person                                                                                             |
| Source to reuse | Personal OS `_ops.ts:36` (`ctx.authority.decide` plus `actingFor`), already used for surface traffic; TaskFlow `feltkit/assistant.ts:22-78` as the reference                                                                   |
| Destination     | When an AppPort request carries an agent credential, FeltKit resolves the AuthBoundry delegation and runs the function as `actingFor` the delegating person. This is a FeltKit change, made in FeltKit, not in the destination |
| Gaps            | Needs agreement with the FeltKit owner on the contract. It is the only cross-repository change in this backlog                                                                                                                 |

**Acceptance:**

- [x] A delegated agent's write runs in the delegating person's space. Proven on a FeltKit test capability and from eve; Personal OS's own `tasks.create` is exercised in 2a.
- [x] An undelegated or revoked agent is refused before the function runs.
- [x] FeltKit's audit record names the person, the agent, and AuthBoundry's decision and delegation. Personal OS's action log does not yet record the agent (2a: read `ctx.auth.delegation`).

**Contract as built:** an agent session plus `X-AppPort-On-Behalf-Of: <person>`. A capability is delegable only when listed in `authority.capabilities`, so 2a adds Personal OS's published names (`tasks.create`, …) there; today it lists only the `personalos.*` surface vocabulary. Local authority only.

### 2a. Tasks, reminders and daily briefing. **Done:** [PERSONALOS-TASKS-BRIEFING-REPORT.md](PERSONALOS-TASKS-BRIEFING-REPORT.md)

|                      |                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source               | PO-06–11 (`tasks.list/create/update/complete`, reopen, delete) and PO-25 (`briefing.today`)                                                                                                                      |
| Destination contract | The existing published contracts, invoked through `appport_invoke`. Reopen and delete need capability declarations; complete, update and delete are consequential and idempotent through FeltKit's durable store |
| AuthBoundry          | A `personalos.tasks.*` read/write split; briefing is read                                                                                                                                                        |
| Tests                | Personal OS tests exist (not run). Add destination e2e: delegated create, repeat, revoke and crash during create, mirroring the reserve suite                                                                    |

**Acceptance:**

- [x] A person delegates tasks and the agent creates and completes a task for them.
- [x] Repeat and crash produce one task.
- [x] Revocation stops later calls.
- [x] The briefing reflects the change.

**As built:** six capabilities, each granted separately: `tasks.list`, `tasks.create`, `tasks.update`, `tasks.complete`, `tasks.reopen` (newly published) and `briefing.today`. **Delete stays the person's own act**, as Personal OS's source states, and is not delegable; changing that is a product decision. Reminders remain Personal OS jobs. Running from npm still needs a FeltKit release from main (after 0.3.32).

### 2b. Memory. **Done:** [PERSONALOS-MEMORY-REPORT.md](PERSONALOS-MEMORY-REPORT.md)

PO-13, 14, 16 (list, add, forget). Memory written by an agent is held **unconfirmed** until the person confirms it (PO-15 stays internal). Forgetting is consequential and requires its own grant.

**Acceptance:**

- [x] An agent-added memory carries agent provenance and is unconfirmed.
- [x] Forget without a grant is refused. Forgetting is never delegable: it removes trusted memory.

**As built:**

- **Delegable:** `memory.list`, and `memory.propose` (new; always `inferred`).
- **Not delegable:** `memory.add` (it writes `confirmed`), `confirm`, `update` and `remove`.
- **Enforcement:** Personal OS's data operations refuse every trusted-memory change under an agent's delegation. Only the person confirms or drops a proposal, in the Memory screen or in conversation.

**Revised from the plan:** forgetting was planned as a grantable write. It is not delegable, because it removes trusted memory.

### 2c. Projects and documents. **Done:** [PERSONALOS-PROJECTS-DOCUMENTS-REPORT.md](PERSONALOS-PROJECTS-DOCUMENTS-REPORT.md)

PO-17, 18 (projects list, create) and PO-20 (documents list). Reading a document's content needs a new `personalos.documents.read` capability. Uploads (PO-21) stay internal.

**Acceptance:**

- [x] Read-only delegation lists projects and documents (separate grants; a project grant exposes no documents).
- [ ] Content read requires its own grant. **Not built.** Personal OS's only content path is `documents.link`, a bearer download URL, and eve has no fetch tool. Reading contents needs a new contract, deferred and recorded.

**As built:**

- **Delegable, each with its own grant:** `projects.list`, `projects.create`, `projects.update`, `documents.list`, `documents.update`.
- **Not delegable:** uploads (bytes travel outside AppPort), download links (bearer URLs) and document removal (the person's own act).
- **Deferred finding:** eve's ledger marks FeltKit's `feltkit.FAILED_PRECONDITION` refusals indeterminate rather than failed.

## 3. Research runs (POS). **Done:** [RESEARCH-RUNS-REPORT.md](RESEARCH-RUNS-REPORT.md)

|                 |                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Source          | PO-30–32 (`research.ts:175`, `researchstate.ts`, the safe page reader `_pages.ts`)                          |
| Destination     | Start, read and cancel/retry published as delegated FeltKit capabilities; the pipeline stays in Personal OS |
| Depends on      | 2.0                                                                                                         |
| Why not earlier | Long-running and costly. Needs a budget per delegation                                                      |

**Acceptance:**

- [x] A delegated start returns a run id.
- [x] Reading it shows citations.
- [x] Cancel stops spend.
- [x] Retry of a completed run is idempotent.

**As built:**

- **Capabilities:** `research.start` and `research.retry` (new mutations: FeltKit refuses actions as capabilities), plus `research.list`, `research.get` and `research.cancel`.
- **Budget:** a per-person, per-agent budget in billable calls (model generations and web searches) that only the person sets. Each start reserves from it atomically; each call is charged before it is made.
- **Stops:** cancellation and revocation stop further calls at the next step.
- **Not measured:** dollars, and page reads.

## 4. Runtime safety mechanisms (INT). **Done:** [RUNTIME-SAFETY-REPORT.md](RUNTIME-SAFETY-REPORT.md)

Internal mechanisms only. None is model-facing. Each is independent.

| Item                               | As built                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4a Stuck-run detection             | Reconciliation classifies running work as `stalled` (blocked, never success, nothing re-sent) when no AppPort call is in flight, no interaction is awaited, and eve's session and the ledger show no progress for `APPPORT_AGENT_STALL_AFTER_MS` |
| 4b Completion gate (SA-38)         | The single checkpoint write refuses `completed` unless the ledger shows every operation final, at least one succeeded with a recorded result or a settled success, and each is cited                                                             |
| 4c Contract-digest pinning (SA-13) | `capabilityDigest` pinned per operation before it is prepared; verified with `compareManifests` before every dispatch, retry and recovery. Breaking or unavailable gives `failed` if never sent, or `indeterminate` if sent before               |
| 4d Read-only work (SA-32)          | `POST /work` `readOnly`, stored in the submission. Only effect `observation` runs; other or undeclared effects are refused before anything is recorded                                                                                           |

**Acceptance:**

- [x] Stalled work is detected durably; an operation that takes long is not marked stalled.
- [x] Work with an indeterminate, unresolved or unrecorded operation cannot report success, on any path.
- [x] An incompatible contract change blocks the operation with a precise, recorded error; a compatible one proceeds with the pin kept.
- [x] A read-only work item cannot call `catalog.reserve`, or a capability with no declared effect.

**Not built:** the original 4a idea, a guard that cancels identical repeated failing calls. **Deferred:** credential path policy SA-33. It applies only when file tools are enabled, and the destination sets `defaultTools: false`.

## 5. Identity linking (EXT). **Done:** [IDENTITY-LINKING-REPORT.md](IDENTITY-LINKING-REPORT.md)

Personal OS already had the lifecycle (PO-35): a one-time code from the person's session, presented by the surface's authenticated account, confirmed by the person, recorded in Resolver by a separate least-privilege agent, and revocable.

This slice:

- verified it against the 22 criteria;
- fixed concurrent confirmation creating two owners, with a FeltDB-unique ownership claim;
- tested the authority boundary, restart and audit;
- ran 14 mutations against the boundaries.

**Acceptance:**

- [x] An external account resolves to one person only with proof of both sides; names, handles and e-mails are never identity.
- [x] One external account belongs to one person, also under concurrent confirmation; no silent transfer.
- [x] A link grants nothing: AuthBoundry grants are unchanged by linking and unlinking, and agents cannot link.
- [x] Revocation holds before Resolver hears of it; links and revocations survive restart.

**Surfaces:**

- X and Multiplayer: linking is implemented. X is tested against a local X API stand-in, not real X.
- Chrome and iOS: they sign in as the person, so there is nothing to link.

## 6. AnywhereAide integration (EXT). **Done:** [ANYWHEREAIDE-INTEGRATION-REPORT.md](ANYWHEREAIDE-INTEGRATION-REPORT.md)

A linked person's request from Multiplayer or X reaches the eve agent and runs under that person's own grants:

```
surface → Personal OS (Resolver) → eve /work → delegated /appport → AuthBoundry
```

Personal OS asserts the person with its own ES256 identity token, and keeps the reply route: the reply is written to the record the request arrived on. Execution and delivery are separate records.

**Acceptance:**

- [x] An unlinked handle gets no action (also revoked and ambiguous).
- [x] A linked handle's request runs under that person's delegation, operation by operation.
- [x] A post never leaks another person's data: X gets only the generic acknowledgement; shared conversations get "done" or "not finished".
- [x] Repeated delivery produces one piece of work and one reply sequence.

**Not live-verified:** real X (stand-in only) and the Multiplayer side (the bridge was played by the test).

## 7. voice-agent delegated tools (EXT). **Closed, not applicable:** [VOICE-AGENT-DELEGATED-TOOLS-REPORT.md](VOICE-AGENT-DELEGATED-TOOLS-REPORT.md)

The source inspection found a category error in this item. voice-agent is a multi-tenant business receptionist: the public calls a business, and its tools (OA-voice-03–08, 10) act for that business on the business's data, under voice-agent's own agent-profile grants. There is no authenticated person on a call; caller ID is not authentication.

The tools stay business-scoped. No code changed. The two directions this item implied are deferred below, each with its prerequisite.

## 8. Contract-verified replacement (CORE). **Done:** [CONTRACT-VERIFIED-REPLACEMENT-REPORT.md](CONTRACT-VERIFIED-REPLACEMENT-REPORT.md)

eve's AppPort dependency is a Resolver `agent` reference, replaced by the deployment operator with no rebuild or restart:

- Resolver verifies each candidate's pinned capability digests on every write and rollback.
- eve re-verifies at use, and refuses drift.
- Each operation keeps the implementation it was prepared against.
- Authority is unchanged: the operator owns the dependency, the agent reads it, and end users cannot reach it.

**Acceptance:**

- [x] A compatible (same-contract) replacement takes effect for new work only.
- [x] Breaking, effect-changed, missing, foreign, unreachable and unlisted candidates are refused, and the active resolution does not move.
- [x] In-flight and indeterminate operations keep their original implementation; there is no blind retry.
- [x] Rollback is re-verified, and every decision survives a restart.

**Readiness:** see [HOSTED-READINESS-ASSESSMENT.md](HOSTED-READINESS-ASSESSMENT.md). Hosted deployment waits for its review.

## Deferred, or needs a decision

| Item                                                                   | Why deferred                                                                                  | Decision needed                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundry evidence check (OA-foundry-14)                                 | AGPL: re-implement only                                                                       | Fold into 4b, or drop                                                                                                                                                                                                                                         |
| Foundry coding, approvals and projects (OA-foundry-01–03)              | Duplicates eve sandboxes and approvals except the network path                                | Is Foundry a product to integrate, or retired?                                                                                                                                                                                                                |
| IMAP email (OA-foundry-15)                                             | No mailbox exists anywhere in the platform                                                    | Is email in Personal OS's scope?                                                                                                                                                                                                                              |
| Office host tools (ai-office 01–04)                                    | UNLICENSED, outside the ecosystem                                                             | Owner and license                                                                                                                                                                                                                                             |
| saaskit reserve/commit/release and spending authority (OA-prod-06, 07) | Overlaps `catalog.reserve` and per-delegation budgets                                         | Where budgets live                                                                                                                                                                                                                                            |
| Workflow mining (SA-42)                                                | No use case                                                                                   | A measured benefit                                                                                                                                                                                                                                            |
| Document extraction (OA-atomic-03), vision (OA-atomic-13)              | Runtime dependencies; multimodal support unverified                                           | Where extraction runs                                                                                                                                                                                                                                         |
| Compute and PAX (OA-foundry-04–06)                                     | Ownership unknown                                                                             | Are they platform services?                                                                                                                                                                                                                                   |
| Credential path policy (SA-33)                                         | No file tools enabled                                                                         | Revisit when they are                                                                                                                                                                                                                                         |
| Business-owner delegation of voice-agent tools (OA-voice-03–08, 10)    | FeltKit's delegated `/appport` carries no tenancy; voice-agent's FeltKit (0.3.19) predates it | Its own approved slice: tenant-scoped delegation in FeltKit with a business-as-principal authority model. Not on the current roadmap                                                                                                                          |
| Personal OS by phone                                                   | No caller verification: caller ID is not identity                                             | A product decision on caller verification first (an unapproved direction)                                                                                                                                                                                     |
| Resolver as a runtime capability of the deployed agent service         | Today each agent would implement resolution (the slice-8 proof lives in the example agent)    | A research document: typed dependency kinds (`agent` with pinned digests, `model` with provider and catalog checks), stable references in configuration, receipts in evidence. Principle: Resolver authority belongs to the owner of the dependency lifecycle |
| Compatibility classification on Resolver re-pins                       | Resolver accepts a re-pin to any served contract, breaking included                           | A change in `rkendel1/resolver`: `compareManifests` between the previous and new pins, refusing breaking ones without acknowledgement                                                                                                                         |
| Staged (verified but inactive) Resolver bindings                       | Verification and activation are one write                                                     | Whether operators need a dry-run or staged activation                                                                                                                                                                                                         |
| FeltKit release with delegated `/appport`                              | 0.3.30 and 0.3.32 lack it; Personal OS pins 0.3.30                                            | Publish, then update Personal OS's pin; a prerequisite for hosting anything delegated                                                                                                                                                                         |
| eve2 CI                                                                | No GitHub Actions run on any eve2 PR                                                          | Enable Actions; add a job with `PERSONALOS_DIR` and `FELTKIT_SDK_DIR` for the example's end-to-end tests                                                                                                                                                      |

## Not to be ported

| What                                 | Why                                                                                       | Inventory                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Everything classified Duplicate (31) | eve, AppPort, FeltDB or the existing ledger already does it                               | Inventory and appendices                                 |
| Everything classified Retire (23)    | chip-rs, 3fx, PAX/cli2/Compute tooling, experiments, unused crates, WebLLM research tools | Inventory and appendices                                 |
| Destination idempotency store growth | FeltKit already provides the durable store to real hosts                                  | Inventory, "Duplication found in the destination itself" |

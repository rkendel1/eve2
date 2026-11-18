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
5 Identity linking, then AnywhereAide (EXT) ── needs 2.0  │
6 voice-agent delegated tools (EXT) ── needs the 2.0 pattern
7 Contract-verified replacement (CORE) ── needs 4 (pinning)
```

Slices 1 and 4 have no dependencies and can be done at any time. Slice 2.0 gates slices 2, 3 and 5.

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

## 3. Research runs (POS)

|                 |                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Source          | PO-30–32 (`research.ts:175`, `researchstate.ts`, the safe page reader `_pages.ts`)                          |
| Destination     | Start, read and cancel/retry published as delegated FeltKit capabilities; the pipeline stays in Personal OS |
| Depends on      | 2.0                                                                                                         |
| Why not earlier | Long-running and costly. Needs a budget per delegation                                                      |

**Acceptance:**

- [ ] A delegated start returns a run id.
- [ ] Reading it shows citations.
- [ ] Cancel stops spend.
- [ ] Retry of a completed run is idempotent.

## 4. Runtime safety mechanisms (INT)

Internal mechanisms only. None is model-facing. Each is independent.

| Item                                | Source                                             | Destination                                                                                             | Acceptance                                                                                                                      |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 4a Stuck guard (SA-30, direct port) | `chip-core/src/stuck.rs:72` and its tests          | eve hook on settled calls → `ctx.cancel("stuck: …")`                                                    | A scripted model repeating an identical failing call is cancelled at the threshold with a recorded reason; varied calls are not |
| 4b Completion gate (SA-38)          | `host_capabilities/mod.rs:499`                     | Work completes `succeeded` only when every consequential operation in it succeeded or was settled       | Work with an indeterminate operation cannot report success                                                                      |
| 4c Contract-digest pinning (SA-13)  | `host_capabilities/appport.rs:215`, `digest.rs:33` | `appport_invoke` refuses a consequential call when the live contract digest differs from the pinned one | Changing the host's `catalog.reserve` schema blocks reserve with a precise error; reads are unaffected                          |
| 4d Read-only goal gating (SA-32)    | stack-agent inspect-kind                           | Work declared read-only rejects consequential capabilities before dispatch                              | A read-only work item cannot call `catalog.reserve`                                                                             |

**Deferred:** credential path policy SA-33. It applies only when file tools are enabled, and the destination sets `defaultTools: false`.

## 5. Identity linking, then AnywhereAide (EXT)

|               |                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source        | PO-35 (identity linking through Resolver), then PO-41–43 (`@anywhereaide` X intake, reply, publish) and PO-45 (Chrome and iOS clients)                       |
| Destination   | Link an external handle to a person through Resolver; an eve X channel then maps inbound content to the linked person's delegation                           |
| Depends on    | 2.0. An X API credential (operational)                                                                                                                       |
| Must preserve | Content is data, never instructions; shared-audience privacy; per-step authority; once-only delivery (from the `interactions.ts` and `invocations.ts` tests) |

**Acceptance:**

- [ ] An unlinked handle gets no action.
- [ ] A linked handle's request runs under that person's delegation.
- [ ] A post never leaks another person's data.
- [ ] Repeated delivery produces one reply.

## 6. voice-agent delegated tools (EXT)

OA-voice-03–08, 10 are already published, but bound to a runtime principal. Rebinding them to delegation follows the 2.0 pattern. Realtime phone voice (OA-voice-02) and transfer (OA-voice-09) are integration work in voice-agent, after the delegated tools.

**Acceptance:**

- [ ] A booking made by the agent carries the business owner's delegation.
- [ ] Revoking it stops bookings.

## 7. Contract-verified replacement (CORE)

|             |                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source      | SE-01 (`appport-agent` plan → implement → verify → roll back) plus SE-08 goal checks                                                                  |
| Destination | An eve workflow in the sandbox using AppPort's existing `compareManifests` and `assessReplacement`. The Rust duplicates (SE-13, 15–19) are not ported |
| Depends on  | 4c (pinning)                                                                                                                                          |
| Why last    | Valuable for developers but not a core user workflow, and the most complex to make safe                                                               |

**Acceptance:**

- [ ] A replacement that breaks the contract is rolled back.
- [ ] A conforming one passes goal checks that failed beforehand.

## Deferred, or needs a decision

| Item                                                                   | Why deferred                                                   | Decision needed                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Foundry evidence check (OA-foundry-14)                                 | AGPL: re-implement only                                        | Fold into 4b, or drop                          |
| Foundry coding, approvals and projects (OA-foundry-01–03)              | Duplicates eve sandboxes and approvals except the network path | Is Foundry a product to integrate, or retired? |
| IMAP email (OA-foundry-15)                                             | No mailbox exists anywhere in the platform                     | Is email in Personal OS's scope?               |
| Office host tools (ai-office 01–04)                                    | UNLICENSED, outside the ecosystem                              | Owner and license                              |
| saaskit reserve/commit/release and spending authority (OA-prod-06, 07) | Overlaps `catalog.reserve` and per-delegation budgets          | Where budgets live                             |
| Workflow mining (SA-42)                                                | No use case                                                    | A measured benefit                             |
| Document extraction (OA-atomic-03), vision (OA-atomic-13)              | Runtime dependencies; multimodal support unverified            | Where extraction runs                          |
| Compute and PAX (OA-foundry-04–06)                                     | Ownership unknown                                              | Are they platform services?                    |
| Credential path policy (SA-33)                                         | No file tools enabled                                          | Revisit when they are                          |

## Not to be ported

| What                                 | Why                                                                                       | Inventory                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Everything classified Duplicate (31) | eve, AppPort, FeltDB or the existing ledger already does it                               | Inventory and appendices                                 |
| Everything classified Retire (23)    | chip-rs, 3fx, PAX/cli2/Compute tooling, experiments, unused crates, WebLLM research tools | Inventory and appendices                                 |
| Destination idempotency store growth | FeltKit already provides the durable store to real hosts                                  | Inventory, "Duplication found in the destination itself" |

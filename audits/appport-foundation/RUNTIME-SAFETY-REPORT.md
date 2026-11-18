# Runtime safety mechanisms (slice 4)

Four mechanisms in the existing eve work path of `examples/appport-agent`:

- stuck-run detection;
- an evidence-based completion gate;
- capability contract digest pinning;
- read-only work enforcement.

Each one extends a component that already exists: work reconciliation, the single checkpoint write, the operation ledger, and the work submission. There is no new service, scheduler, monitor, sidecar or policy engine. None of them is reachable by the model.

## Where each mechanism lives

| Mechanism           | Enforcement point                                                                                                                                                                                        | Durable state                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stuck-run detection | `reconcileWork`, `running` case (`agent/lib/recovery.ts`). Runs on startup reconciliation and `POST /work/reconcile`, the paths that already existed                                                     | The work checkpoint: status `blocked`, decision `stalled: no progress since <iso> (…)`                                                                                                      |
| Completion gate     | `recordProgress` (`agent/lib/work.ts`): every write of `completed` passes `completionRefusal`                                                                                                            | The work checkpoint: status `blocked`, decision `blocked: not completed: <reason>`                                                                                                          |
| Contract pinning    | Pinned in `runOperation` when the operation is first recorded. Verified in `attempt_` before every dispatch (`agent/lib/operations.ts`), using `contractPin` / `verifyContract` (`agent/lib/appport.ts`) | `appport_operations.contract` (pin, never replaced) and `contract_checks[]` (each verification that was not `same`)                                                                         |
| Read-only work      | `runOperation`, before an operation is recorded                                                                                                                                                          | `POST /work` `readOnly` is stored in the submission (`read_only`). Refusals are stored in `appport_invocations` with `refusal: "READ_ONLY_WORK"` and detail `{capability, effect, message}` |

`GET /work/:id` now also returns:

- `ledger`: every operation of the work, with its state, `contractDigest`, `contractChecks`, `effect`, `errorCode`, resolution and settlement;
- `readOnly`;
- `refusals`: call links refused before an operation existed.

Operations that never reached a final state, and refused calls, are therefore visible. Before this slice, `operations` showed only cited ones.

## 1. Stuck-run detection

**Evidence used.** The criteria are deterministic, and all of them are evidence eve or the ledger already records:

- the latest `startedAt`/`endedAt` of the session's turns, runs and calls (eve's own session view);
- the latest `updated_at` of the work's ledger operations;
- whether an `appport_invoke` call is unsettled (in flight);
- whether the turn is waiting on an interaction (already classified as `waiting`).

**Rule.** A work item is **stalled** only when all of the following hold:

- its session is running;
- no AppPort call is in flight;
- no interaction is awaited;
- nothing has happened for longer than `APPPORT_AGENT_STALL_AFTER_MS`. The default is 15 minutes.

**What a stalled mark does and does not do.**

- Stalled is written as `blocked` with a `stalled:` decision. It is never `completed`, and it is distinct from `indeterminate:` (an operation with an unknown outcome) and from `waiting:`.
- Nothing is cancelled, retried or re-sent.
- If the session later makes progress, the next reconciliation marks it `running` again, and the final checkpoint still passes the completion gate.

**Restart.** The mark is in FeltDB, so it survives a restart. After a restart, eve resumes the turn. If the turn stalls again, it is classified again from fresh timestamps; there is no in-memory timer.

**Limits.**

- An AppPort call in flight is never declared stalled, however long it takes. A hung destination call is bounded only by the request timeout, and is otherwise reported by the existing indeterminate path.
- A hung model call is detected only by the threshold. Nothing distinguishes "slow" from "hung" below it.
- Detection runs when reconciliation runs: at startup and when an operator calls `/work/reconcile`. No new scheduler was added.
- The original backlog item 4a, a guard that cancels identical repeated failing calls, is not built. This slice implements the no-progress detection requested instead.

## 2. Evidence-based completion gate

`recordProgress` is the only function that writes a work checkpoint. Every path to `completed` goes through it:

- a turn's final checkpoint;
- startup and operator reconciliation;
- settlement-driven completion.

`completionRefusal` reads only the work submission and the ledger. It refuses when:

- there is no submission, or no operation is recorded for the work ("a reply is not evidence");
- any operation is `prepared`, `executing` or `indeterminate`;
- an operation's requester differs from the submission's;
- an operation's settlement contradicts its state;
- no operation succeeded;
- a succeeded operation has no recorded result. A recorded result is `outcome.ok` with an `output_digest` and a `request_id`, or a settlement of `succeeded`;
- a succeeded operation is not cited by the checkpoint.

**Outcome when refused.** The write becomes `blocked` with `blocked: not completed: <reason>`. Blocked, failed (ledger `failed`) and indeterminate stay distinct.

**What the model cannot do.** The model cannot write ledger records, results or settlements. Settlement is the operator route from slice 1.

**Deliberate consequence.** Work that legitimately needs no AppPort operation cannot complete; it ends blocked. That is the requested rule ("no successful terminal state without the required durable evidence").

## 3. Capability contract digest pinning

**Representation.** `ContractPin = {digest, version, entry, integration}`. Its parts:

- `digest`: AppPort's `capabilityDigest(manifest, name, version)`, which covers the capability definition and its integration declaration;
- `entry`: a copy of the manifest entry;
- `integration`: that version's integration declaration.

Only the capability is pinned, not the whole manifest.

**Lifecycle.**

- **Capture:** in `runOperation`, when the operation is first recorded, before it is prepared or sent. If no pin can be computed, the operation is not recorded (`CONTRACT_UNAVAILABLE`).
- **Verification:** in `attempt_`, before every dispatch: the first send, a retry and recovery alike.
- **Comparison:**
  - a byte-equal digest is `same`;
  - a missing capability or version is `unavailable`;
  - a changed integration declaration is `breaking`, because AppPort's comparison does not evaluate it, so compatibility is not established;
  - otherwise AppPort's `compareManifests` (§43) runs on manifests reduced to the one capability. Its verdict is `compatible` or `breaking`, and its change list is recorded.
- **Dispatch:** uses the pinned entry and pinned version. The pin is never replaced; a compatible newer digest is only recorded in `contract_checks`.

**On a breaking change or an unavailable contract:**

- **Never sent** (`prepared`, no request id): the operation becomes `failed` with `CONTRACT_CHANGED` / `CONTRACT_UNAVAILABLE` and the resolution "Not sent: …". Nothing reaches the destination.
- **Sent before** (outcome unknown): the operation becomes `indeterminate`, "Not sent again: … Whether the earlier attempt took effect is not established". It is never re-executed because of the change; the operator settlement path from slice 1 resolves it.
- **Removed capability:** resolution already fails before an operation is touched (`NOT_EXPOSED`). The work blocks, and the prepared operation stays unsent. The `unavailable` verdict inside `verifyContract` is defence in depth for a manifest that resolves but lacks the pinned version.

**Verified AppPort 1.5.0 behaviour this relies on:**

| Change                                 | Digest  | AppPort verdict                |
| -------------------------------------- | ------- | ------------------------------ |
| Description only                       | changes | compatible                     |
| Optional input field added             | changes | compatible                     |
| Required input field added             | changes | breaking (`input.field-added`) |
| Effect `consequential` → `observation` | changes | compatible                     |

The last row is why read-only enforcement does not rely on contract compatibility.

## 4. Read-only work

**Authoritative source.** The `readOnly` flag of the authenticated `POST /work` request, stored in the work's durable submission.

- It is part of the idempotent request: the same key with a different `readOnly` is `409`.
- Nothing the model produces can set or clear it.

**Classification.** It comes from the destination's declared `effect` in the capability manifest. Only `observation` may run. `consequential`, any other value, or no declared effect is refused. Nothing is inferred from names.

**Enforcement.** `runOperation` checks the current manifest entry before anything is recorded or sent. The model's tool call is the only way an operation starts, and retry and recovery re-enter through the same call path, so retry and recovery are checked identically.

**Refusal.** The tool returns `READ_ONLY_WORK` to the model. The refusal is stored as a call link with its capability, effect and message, attributable to the work and call.

Work without `readOnly` behaves as before.

## Cross-mechanism invariants held

- Stalled ≠ indeterminate ≠ waiting ≠ blocked-by-gate. Each has its own decision prefix and none is success.
- No mechanism retries, re-sends or settles anything.
- Contract refusal of a never-sent operation produces no request. A changed contract on a sent operation yields indeterminate, which the completion gate refuses.
- A read-only refusal creates no ledger operation, so it cannot be cited as evidence. The gate then blocks the work.

## Tests

`test/safety.test.mjs`. Everything is real except the model:

- real eve (`eve start`), with the scripted `mockModel` fixture;
- the AppPort probe host as its own process, restarted with a changed contract;
- AuthBoundry delegation;
- FeltDB.

Crashes are `SIGKILL` at named fault points. The test-only host switches are `PROBE_CONTRACT` (`compatible` / `breaking` / `removed`), `PROBE_HOLD_FILE` (a handler that legitimately takes long) and `probe.unclassified` (no declared effect).

| Test                                                                                                                                                                          | Acceptance covered                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A hanging turn is classified `stalled`, read back from the store with eve stopped, and re-classified after restart; the ledger is empty (nothing dispatched)                  | 1 genuinely stalled work detected; stall durable; no redispatch; visible in inspection      |
| An operation held for longer than the threshold is `running`, then completes with one effect                                                                                  | 2 legitimate long-running operation not marked stalled                                      |
| A reply without any operation is `blocked: not completed: …`                                                                                                                  | completion requires ledger evidence; model words are not evidence                           |
| A destination crash while completing leaves the operation `executing` and blocks the work. A crash after send leaves it `indeterminate`, which also blocks                    | no completion with an unresolved or indeterminate operation; blocked/indeterminate distinct |
| A recorded result removed from the ledger while eve is down blocks the recovery checkpoint; the same crash with the record intact completes                                   | the gate holds on the recovery path; results must be persisted                              |
| The pin is stored before send (crash at `operation.prepared`, store read directly); after a compatible change it completes, the pin is unchanged, and the check is recorded   | digest captured before prepare, persisted, never replaced; compatible change proceeds       |
| A breaking change before send gives `failed CONTRACT_CHANGED`, with `breaking: input.field-added` recorded; no authorization reaches the host; no effect                      | incompatible change refused, recorded durably and visibly, not sent                         |
| A breaking change before a retry in a new turn gives `indeterminate` "Not sent again"; one send, one effect                                                                   | verified before retry; no re-execution because the contract changed                         |
| A breaking change before recovery after a crash after send gives `indeterminate`; one send, one effect                                                                        | verified before recovery                                                                    |
| `verifyContract` against a manifest without the capability gives `unavailable`; `contractPin` gives `null`                                                                    | unavailable contract fails closed                                                           |
| A removed capability before recovery blocks the work; not sent; no effect                                                                                                     | unavailable contract fails closed end to end                                                |
| A read-only lookup completes                                                                                                                                                  | read-only allows observations                                                               |
| Read-only `catalog.reserve` → `READ_ONLY_WORK` (effect `consequential`) and `probe.unclassified` → `READ_ONLY_WORK` (effect `null`); no ledger operation, inventory unchanged | enforced before handler; unknown effect fails closed; refusal durable and attributable      |
| The same key with `readOnly` flipped gives `409`                                                                                                                              | classification cannot be changed afterwards                                                 |
| A read-only crash at `checkpoint.final`, then recovery: refused again; inventory unchanged                                                                                    | recovery enforced identically                                                               |
| Non-read-only reserve decrements inventory and carries a `sha256:` pin                                                                                                        | direct behaviour unchanged                                                                  |

**Results:**

- `node --test test/safety.test.mjs`: **16/16 passed** (about 65 s).
- Full destination suite, with `FELTKIT_SDK_DIR` and `PERSONALOS_DIR` set: **133/133 passed** (the 117 earlier tests plus these 16).
- No AuthBoundry processes left behind.

## Mutation checks

Each gate is removed in turn and the relevant tests are run. The harness is in the scratchpad, not the repo. Each mutation edits `agent/` and restores it.

| Mutation                                                                         | Tests that fail                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Completion gate removed (`completionRefusal` result ignored)                     | no operation → no completion; missing result on recovery                                                                 |
| Stall rule never triggers                                                        | hanging turn classified stalled                                                                                          |
| In-flight exclusion removed from the stall rule                                  | long-running operation not stalled                                                                                       |
| Contract verification before dispatch skipped                                    | pin kept on compatible change (no check recorded); breaking before send; breaking before retry; breaking before recovery |
| AppPort compatibility verdict ignored (always compatible)                        | breaking before send, retry and recovery                                                                                 |
| Missing current contract taken as same                                           | unavailable verdict                                                                                                      |
| Read-only effect check removed                                                   | side effect refused; refused again on recovery                                                                           |
| Undeclared effect allowed (`=== "consequential"` instead of `!== "observation"`) | undeclared effect refused                                                                                                |
| `pin === null` refusal of a new operation removed                                | **none: survives**                                                                                                       |

**8 of 9 mutations are caught.** The surviving one is masked, not missed. Without the refusal, an operation would be recorded with no pin. `attempt_` then treats it as `unavailable` and fails it closed before anything is sent, so the outcome is the same, except that the record exists. End to end, this state cannot be produced either, because resolution already requires the capability in the manifest. The refusal is kept so that no operation is ever recorded without a pin.

## Real vs mocked

| Real                                                                                                                                                                                            | Mocked                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| eve runtime, work channel, recovery, FeltDB ledger and checkpoints; AppPort protocol, manifest, `capabilityDigest`, `compareManifests`; AuthBoundry authorization; process crashes and restarts | the model (scripted `mockModel`); the destination capabilities are the probe host's, and the contract changes are test switches on it |

## Limitations and deferred findings

- **Hung AppPort calls.** An AppPort call that hangs is in flight and never counts as stalled.
- **Hung model calls.** These are detected only by the idle threshold.
- **No operation-free completion.** Work that needs no AppPort operation cannot complete; it ends `blocked`. This follows from the requested evidence rule.
- **Only the current entry's effect is checked.** The read-only check reads the effect of the current entry. An operation of read-only work can only exist if that check passed when it was recorded, and every later attempt passes the same check again, so a separate check on the pinned effect would be unreachable and is not kept.
- **Integration declaration changes.** Any change to a capability's integration declaration is treated as breaking. AppPort's comparison does not evaluate it.
- **`feltkit.FAILED_PRECONDITION`.** It is treated as indeterminate by the ledger (found in slice 2), and remains so.
- **Repeated-call guard.** The guard for identical repeated failing calls (backlog 4a as first written) is not built.

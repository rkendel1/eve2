# eve AppPort agent: durable operation safety

Branch `claude/dreamy-galileo-4z03p5`, building on `2c8500c`.

The problem from the recovery milestone: eve abandoned a call that was interrupted after AppPort answered, and the model issued it again. AppPort executed twice. This milestone adds the smallest boundary that stops an interrupted call from silently repeating an external action, and never reports an uncertain outcome as a success.

The ledger is `agent/lib/operations.ts` (about 400 lines), using the existing FeltDB work store. There is no new service, queue, scheduler or framework.

## Phase 1: the real identifiers

| Identifier                                                                                       | Stable across eve's retry of an abandoned call?                                             | Across process restarts?                              | Across re-delivery of the same work? | Distinct per operation in one work?                             | Evidence                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- | ----------------------------------- |
| eve call id (`ctx.callId`)                                                                       | **No.** The re-issued call is a new call (`mock-tool-call-2-…` after `…-1-…` was abandoned) | The recorded id persists, but the retry has a new one | n/a                                  | Yes within a session; the mock's ids **repeat across sessions** | Recovery milestone: recorded events |
| AppPort `requestId`                                                                              | **No.** A new id per request                                                                | No                                                    | No                                   | Yes                                                             | `sendRequest` mints `eve_<uuid>`    |
| AppPort `traceId`                                                                                | Yes (set to the work id)                                                                    | Yes                                                   | Yes                                  | **No.** Shared by every operation of the work                   | Provenance                          |
| Work id                                                                                          | Yes                                                                                         | Yes                                                   | Yes (derived from requester and key) | **No**                                                          | Durable-work milestone              |
| **Operation id** = `op_` + sha256(work id, capability, `operationKey` or canonical input digest) | **Yes**, when the retry has the same input or key                                           | **Yes**                                               | **Yes**                              | **Yes**, unless the model repeats identical input without a key | Tests 2, 4 and 6                    |

**AppPort idempotency (§44), read from `@appport/core` 1.8.0:**

- A capability declares `idempotency: "supported"`, and requests carry `idempotencyKey`.
- The runtime claims the key before the handler runs and replays the stored response on a repeat (telemetry `idempotentReplay: true`).
- A replay that finds an unresolved claim gets `CONFLICT` / `IDEMPOTENCY_OUTCOME_UNKNOWN` and is not run again.
- Keys are scoped per AppPort **session** and capability version, and the default store is **in memory**.

**Fixed here:** the host minted a new AppPort session per request, which would make every key miss. It now derives one stable session per (agent, person).

## Phases 2 and 3: the ledger

**Operation record** (`appport_operations`, id = operation id):

- identity: `work_id`, `requester`, `agent`, `capability` and `capability_version`;
- input: `input_digest` (RFC 8785 canonical digest; the input itself is not stored) and `operation_key`;
- downstream: `retry_safety` (`idempotency-key`, `observation` or `none`, from the AppPort manifest) and `idempotency_key`;
- progress: `state`, `executor` (this process's id while executing), `attempts` and `request_ids`;
- result: `outcome` (ok, output, output digest, error, `request_id`, `reconciled_after_interruption`), `resolution`, and timestamps.

**Call links** (`appport_invocations`, id = `<work>.<call>`) record which operation each eve call resolved to, or why it was refused.

**Lifecycle.** All writes are FeltDB compare-and-set (`updateIfVersion`) or create-if-absent.

```
prepared ──(commit)──▶ executing(executor) ──(send, with key if supported)──▶ succeeded | failed | indeterminate
```

| On a repeated attempt                      | Behavior                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| succeeded / failed                         | The recorded outcome is returned; nothing is sent                              |
| indeterminate                              | `OPERATION_INDETERMINATE` is returned; nothing is sent                         |
| prepared                                   | Sent (nothing was sent before)                                                 |
| executing, same process                    | Joins the in-flight attempt                                                    |
| executing, process gone, `idempotency-key` | Sent with the same key; AppPort replays                                        |
| executing, process gone, `observation`     | Sent again (a repeated read)                                                   |
| executing, process gone, `none`            | **indeterminate**, with a resolution note                                      |
| Same id, different input or capability     | `OPERATION_CONFLICT`; the call is recorded as refused; the intent is unchanged |

**What counts as evidence.**

- Work outcomes (`decideOutcome`, shared by the live handler and the reconciler) resolve each eve call through its link to its operation's committed state.
- Only `succeeded` and `failed` operations are cited.
- An eve call with no link, or whose operation is not settled, makes the work `indeterminate: N AppPort operation(s) without an established outcome`.

## Phase 4: the uncertain-outcome boundary

All of this was observed in `test/work.test.mjs` against real `eve start`, FeltDB on disk, the AppPort HTTP host and AuthBoundry.

- **Crash method:** `SIGKILL` of the eve server at the fixture's named fault points.
- **Inspection:** after the crash, the test confirms the whole process group is gone, then opens FeltDB directly.
- **Downstream:** test-only capabilities `probe.applykeyed` (`idempotency: "supported"`) and `probe.applyunkeyed` count their effects.

| Crash point                                                                            | State in FeltDB after the crash | Effects then | After restart and the model's retry                                                                       | Effects finally | AppPort requests |
| -------------------------------------------------------------------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- | --------------- | ---------------- |
| After `prepared`, before `executing` (unkeyed)                                         | `prepared`                      | 0            | Sent once → `succeeded`                                                                                   | **1**           | 1                |
| After the effect, before the outcome (keyed)                                           | `executing`                     | 1            | Same key → AppPort **replayed** (`idempotentReplay: true`) → `succeeded`, `reconciled_after_interruption` | **1**           | 2 (one replay)   |
| After the effect, before the outcome (unkeyed)                                         | `executing`                     | 1            | **indeterminate**; not sent                                                                               | **1**           | 1                |
| The same unkeyed operation after two reconciliation passes, a restart and a third pass | `indeterminate`                 | 1            | Unchanged                                                                                                 | **1**           | 1                |
| After the effect, before the outcome (`catalog.lookup`, observation)                   | `executing`                     | —            | Read repeated → `succeeded`                                                                               | —               | 2 (both reads)   |

**The four distinctions:**

- **At-most-once invocation attempt:** not provided. A stale `executing` operation is re-sent when the downstream offers a key, or when it declares no effect.
- **Downstream idempotent execution:** demonstrated. The handler ran once across a crash, because AppPort replayed under the same key, but only while the host process (and its in-memory idempotency store) stayed up.
- **Outcome reconciliation:** demonstrated for keyed operations, by replay. Unkeyed operations are not reconciled; they become indeterminate.
- **Exactly-once effects:** **not claimed.** No test shows it across a restart of the AppPort host, and no external system was involved.

## Phase 5: results

| #   | Requirement                                        | Test                                              | Result                                                                                                 |
| --- | -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Intent persisted before invocation                 | `persists the intent before invoking…`            | `prepared` in FeltDB, 0 effects, 0 AppPort requests                                                    |
| 2   | Repeated request returns the existing result       | `returns the recorded result…`                    | 1 operation, 1 effect, 1 AppPort request for two calls                                                 |
| 3   | Same id, different input, rejected                 | `refuses the same operation key…`                 | The second call is linked as `OPERATION_CONFLICT`; `C1-changed` has 0 effects; the intent is unchanged |
| 4   | Different operations stay distinct                 | `keeps different operations…distinct`             | 2 operations, 1 effect each                                                                            |
| 5   | Crash before invocation resumes                    | `persists the intent before invoking…`            | `succeeded`, 1 effect                                                                                  |
| 6   | Crash after an idempotent effect, no duplicate     | `does not repeat an idempotent action…`           | 1 effect; the second request was a replay                                                              |
| 7   | Crash after a non-idempotent effect: indeterminate | `marks a non-idempotent action indeterminate…`    | `indeterminate`, 1 effect, 1 request; the work is indeterminate with no evidence                       |
| 8   | Indeterminate stays indeterminate                  | `keeps an indeterminate operation indeterminate…` | Unchanged after 3 passes and a restart                                                                 |
| 9   | Failure not silently retried                       | `records a failed operation once…`                | `INVALID_INPUT` → `failed`; the second call made no request                                            |
| 10  | Isolation and authorization                        | `still enforces delegation…`, plus earlier suites | Bob → `FORBIDDEN` → `failed`, 0 effects; Alice can't read Bob's work                                   |
| 11  | Earlier work, recovery and idempotency tests       | All suites                                        | Green                                                                                                  |
| 12  | Evidence belongs to the right work and operation   | `is authoritative in FeltDB itself`               | Every citation and call link belongs to its own work                                                   |

**Runs:**

- The full suite passed 43 of 43 with the real Anthropic model: 42 in the full run, and the discovery test (whose exact-match expectation needed the new `idempotency` field) re-run green in the acceptance file.
- The key appeared 0 times in the logs, and no processes were left running.

**Mutation checks**, each on the full work suite:

| Mutation                                  | Tests that failed                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Existing-operation check removed          | 4: non-idempotent crash, repeated recovery, repeat request, failure-not-retried |
| Indeterminate treated as retryable        | 2: non-idempotent crash, repeated recovery                                      |
| Input change allowed under an existing id | 5, led by the conflict test                                                     |

## Who guarantees what

| Party                      | Guarantees (observed here unless marked)                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **eve**                    | Resumes interrupted turns. Does not re-run a call whose start was recorded (it settles it `abandoned`). Does **not** stop the model from issuing a new call, and its call ids are not stable across that retry                                                                                          |
| **Operation ledger**       | Intent and identity are durable before anything is sent. A settled operation is never re-sent. An operation with no downstream key that was interrupted while executing is never re-sent and becomes `indeterminate`. Conflicting reuse of an id is refused. Evidence is only committed operation state |
| **AppPort**                | With `idempotency: "supported"` and the same key, session, capability, version and input, it replays instead of re-running the handler. This holds within the life of its idempotency store (in memory by default). Pre-execution rejections (authorization, input) mean the handler did not run        |
| **Downstream idempotency** | It is the only thing that turns "sent again after an interruption" into "ran once". Without it, the ledger can only stop the repetition (indeterminate)                                                                                                                                                 |
| **A person**               | Must resolve `indeterminate` operations. Nothing in this slice does it                                                                                                                                                                                                                                  |

**Whether operation identity survives:**

- _Process restarts:_ yes (observed).
- _eve's retry after an abandoned call:_ yes, when the model repeats the same input (observed with the scripted model).
- _A real provider's retry:_ **inferred, not observed.** A real model may change the input or omit the key, which creates a new operation and could act twice. The ledger cannot detect that.

## Observed versus inferred

**Observed:** everything in the tables above, with a scripted model, a real eve server crash, real FeltDB, the real AppPort HTTP path, and real AuthBoundry.

**Inferred, not tested:**

- behavior when the AppPort host itself restarts (its in-memory idempotency store would be lost, so a keyed replay could run the handler again);
- the Postgres world;
- concurrent attempts across processes (excluded by FeltDB's single-writer lock);
- a real provider's retry behavior.

## Remaining limitations

- **No resolution path for `indeterminate`.** There is no operator route to mark an operation succeeded or failed after checking downstream.
- **AppPort's idempotency store** in the example host is in memory, so a real write capability needs a durable store implementing `claim`/`release`.
- **Model-chosen identity.** If the model changes input or key on retry, the ledger sees a new operation.
- **No deliberate retry policy for failed operations.** A failure is final for that operation id.
- **The input is not stored**, only its digest. A retry must present the input again.
- **Consequential capabilities** need accepted work and an operator allowlist entry, and none ships enabled.

# eve AppPort agent: durable work recovery

Branch `claude/dreamy-galileo-4z03p5`, building on `c00e53d`.

The goal: on restart, every unfinished work record is reconciled with what eve actually recorded. Work resumes only when the existing execution can continue safely. Otherwise it is marked waiting, failed, or explicitly indeterminate. Nothing is rerun because a record says `running`, and nothing is inferred from model text.

## Ownership

| System      | Owns                                                                          | Recovery uses                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FeltDB      | Work records, checkpoints, submissions, session bindings, invocation evidence | The authoritative record that reconciliation updates                                                                                                                                                 |
| eve         | Sessions, turns, calls, workflow resumption                                   | `sessions.attach().stream({ follow: false })` (`eve/server`), `foldEvents`, `turns`, `calls`, `callState`, `waiting`, `reply` (`eve/events`); `resolveSession` and `from().send()` in channel routes |
| AppPort     | Invocation and provenance                                                     | Independent cross-check in tests (`traceId` = work id)                                                                                                                                               |
| AuthBoundry | Delegated authority                                                           | Unchanged; enforced at every invocation, including resubmitted work                                                                                                                                  |

The reconciler (`agent/lib/recovery.ts`) is about 175 lines. It schedules nothing and executes nothing itself. It reads eve and FeltDB, and either writes one checkpoint or sends the original submission once to its existing address.

## Phase 1: recovery semantics

**What eve guarantees (documented in `concepts/execution-model-and-durability`, and observed here):**

- The local world recovers active runs at startup. An interrupted step re-runs from its last checkpoint, and completed steps are never re-run.
- A tool call whose start is in the recovered stream is **not** re-run. eve settles it `abandoned` (`step-interrupted`).
- **Channel handlers and hooks do not run again** for events an interrupted attempt already wrote. That is why a final work checkpoint can be lost even though eve recorded `turn.settled`.
- A delivery idempotency key is remembered per session (the last 1,024 keys), and one active session holds a channel address.
- **eve has no startup hook for channels.** Session reads and sends exist only inside the eve server, and sends only inside route handlers.

| Case                                          | How it is distinguished                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted, never submitted                     | No session at the work's address (`resolveSession`) and none recorded; the task is `ready`                                                     |
| Active execution                              | Last turn `status: "running"`                                                                                                                  |
| Execution completed, final checkpoint missing | Last turn `settled` with `outcome: "completed"`, but the task is not terminal or the decision differs                                          |
| Waiting for an event or approval              | Running turn with `waiting(view, turnId).on === "interaction"`                                                                                 |
| Execution failed                              | Settled turn with `outcome` `failed` or `cancelled`                                                                                            |
| Cannot be determined                          | No session where one was recorded or expected, the stream is unreadable or empty, or a settled `appport_invoke` call has no committed evidence |

## Phases 2 to 4: what was built

- **Startup reconciliation.**
  - Runs once per process, before the first `/work` request is answered, and on demand through `POST /work/reconcile` (operator principal only).
  - Writes only when the derived status or decision differs, and every write is version-fenced, with a bounded retry on `VERSION_CONFLICT`.
- **The submission window.** `POST /work` now commits a `work_submissions` record before the task: the objective and the caller's verified `AuthResult` (claims only, never the token). If eve dies after the record and before the send, reconciliation sends the original objective once, to the same address, with the same delivery key and the submitter's recorded identity. AuthBoundry still decides each invocation at that time. Key reuse with a different objective is still `409`.
- **Incomplete progress writes.**
  - The work-to-session binding moved from eve state into FeltDB (`work_sessions`, written by `turn.started` before any tool runs).
  - Invocation evidence is keyed by work id plus eve call id.
  - The live handler and the reconciler share one outcome rule (`decideOutcome`). A settled call without committed evidence makes the work `indeterminate`.

| Fact                                                       | Reconstructable from                                 | Treatment                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Turn started, session, turn outcome, reply text            | eve's recorded stream                                | Reconstructed; the decision is marked `recovered: …`              |
| Which `appport_invoke` calls happened and their eve status | eve's recorded stream                                | Used to find calls lacking evidence                               |
| Invocation outcome (allowed, rejected, output digest)      | Only the committed `appport_invocations` record      | Cited if present; **never reconstructed**                         |
| AppPort's own view of a call                               | AppPort provenance (host JSONL, `traceId` = work id) | Not readable by the agent; used by tests as the independent check |
| Whether an interrupted call took effect                    | Nothing the agent can read                           | Work stays `indeterminate`                                        |

## Phase 5: evidence

`test/work.test.mjs` runs real `eve start`, FeltDB on disk, AppPort and AuthBoundry, with a scripted model.

- **Crash method:** the fixture's `faults.ts` sends `SIGKILL` to the eve server at a named point.
- **Restart method:** the test kills the whole process group and asserts it is gone before restarting.

| #   | Requirement                                         | Test                                                                            | Observed                                                                                                                                                                                         |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Ready work recovered after a crash before execution | `recovers accepted work…`                                                       | `completed`, `recovered: submitted…`, exactly **1** AppPort lookup for the work                                                                                                                  |
| 2   | Active execution not duplicated                     | `does not resubmit…interrupted after AppPort answered`                          | Same session; no `recovered: submitted`; work `indeterminate` (see observed behavior)                                                                                                            |
| 3   | Completed execution with a lost final checkpoint    | `reconstructs a completed execution…`                                           | `completed`, decisions `recovered: final state reconstructed from eve session …` then `completed after 1…`; 1 verified citation; 1 lookup                                                        |
| 4   | Failed execution accurate                           | `records a failed execution…`                                                   | `blocked`, `failed: the eve turn ended failed`, no evidence                                                                                                                                      |
| 5   | Waiting stays waiting                               | `keeps waiting work waiting…`                                                   | After restart: `blocked`, `waiting: the eve session is waiting for an interaction`                                                                                                               |
| 6   | Repeated reconciliation changes nothing             | `changes nothing when reconciliation runs again`                                | Two operator passes, every action `unchanged`; every work view byte-identical                                                                                                                    |
| 7   | Same key idempotent after restart                   | `stays idempotent…`                                                             | `200 replayed`, same work; AppPort count unchanged                                                                                                                                               |
| 8   | Missing session gives no false completion           | `does not report completion when the eve session is gone`                       | eve's workflow data deleted: `indeterminate: eve session … could not be read`                                                                                                                    |
| 9   | Failed checkpoint visible, no invented evidence     | `leaves a failed checkpoint write visible…`, `never cites evidence…`            | Work stays `running` until reconciled, then `completed` with the `recovered` marker. With the evidence write failed: `indeterminate`, `evidence: []`, although AppPort shows a successful lookup |
| 10  | Existing authorization, provenance and isolation    | Earlier suites, plus a FeltDB check that every citation belongs to its own work | Unchanged; all green                                                                                                                                                                             |

**Mutation checks:**

| Mutation                                                                        | Result                                 |
| ------------------------------------------------------------------------------- | -------------------------------------- |
| Duplicate-session protection removed: a fresh address and delivery key per send | 16 of 18 work tests fail               |
| Targeted variant: the reconciler ignores the existing session and resubmits     | 6 recovery tests fail                  |
| An unreadable session treated as completed                                      | 1 test fails: the missing-session test |

**Results:**

- The full suite passed 34 of 34 with the real Anthropic model on the final code.
- The key appeared 0 times in the logs, and no processes were left running.

## Observed behavior, separate from inference

**Observed** in eve's recorded facts after the mid-turn crash:

```
call.requested  mock-tool-call-1-0-1-1 appport_invoke {sku: BETA-2}
call.settled    mock-tool-call-1-0-1-1 abandoned (step-interrupted)
call.requested  mock-tool-call-2-0-1-1 appport_invoke {sku: BETA-2}     <- the model called again
call.settled    mock-tool-call-2-0-1-1 completed
turn.settled    completed
```

- AppPort answered **twice** for that work.
- eve did not re-run the call. The **model** issued a new one after seeing the abandoned call, as eve documents ("the model decides what to call again").
- The reconciler did not resubmit.
- The work is `indeterminate`, because call 1 reached AppPort and its outcome was never committed.
- **For a side-effecting capability this would be a duplicate external action. Neither eve nor this recovery prevents it.** The next milestone must solve it with an operation id and intent/outcome reconciliation.

**Inferred, not observed:**

- Behavior on the Postgres world.
- Behavior with a real provider's call ids.
- Recovery when eve's own run recovery fails.
- Long-delayed resubmission: whether the recorded identity should still be honored hours later is a policy decision. AuthBoundry still enforces revocation.

## Defects found and fixed

1. **Evidence keyed by call id alone allowed cross-work citations.** The mock model's call ids are positional (`mock-tool-call-1-0-1-1`) and repeat across sessions, so one work cited another work's invocation. Evidence is now keyed `<workId>.<callId>`, checked on read, and asserted across all tasks.
2. **The work-to-session binding was lost on crash.** The tool read the work id from eve state that the `turn.started` handler had set, and eve doesn't re-run handlers after an interrupted attempt. After recovery, the model's second call carried no work id. The binding now lives in FeltDB.
3. **A failed open was memoized forever** (fixed in the previous slice; re-verified here).

## FeltDB finding

`collection.insert` accepts a record id containing `:`, but checkpoint evidence citations refuse it (`id must be 1-128 characters of [A-Za-z0-9._-]`). Citation ids are now restricted to that set, and other call ids are hashed.

## Cannot yet be recovered safely

- **Whether an interrupted call took effect.** It is recorded as `indeterminate`, with no automatic action. It needs intent records written before the call, plus an AppPort idempotency key (next milestone).
- **Model-driven repetition after an abandoned call.** Observed; not prevented.
- **Work whose session was lost** (data deleted, history expired). Indeterminate; needs an operator decision. There is no retry or cancel route.
- **Reconciliation needs a request.** eve offers no startup hook, so a supervisor must call `POST /work/reconcile` (or any `/work` route) after start. Until then, unfinished records are not reconciled.
- **Approvals.** Waiting work is represented correctly, but no route answers the approval.
- **Single eve process per work store** (the FeltDB lock).
- **Retention.** Submissions keep JWT claims for the life of the work record.

## Test seam

`agent/lib/faults.ts` is a no-op in the shipped agent and has no caller-controlled input. The acceptance fixture replaces it, along with `agent.ts` and an added approval tool, in a generated copy of `agent/`. That keeps fault injection out of production behavior.

# eve AppPort agent: FeltDB durable work

The agent now accepts work through an authenticated, idempotent route and keeps an authoritative record of each piece of work in FeltDB. That record lives apart from eve's sessions, and each AppPort invocation is linked to it.

| Item           | Version or details                                                                    |
| -------------- | ------------------------------------------------------------------------------------- |
| Branch         | `claude/dreamy-galileo-4z03p5`, building on `658f87e`                                 |
| `@feltdb/core` | 0.22.0, local file runtime (repository `rkendel1/flow_db` at `0f5049e`, same version) |
| eve            | 1.0.2 (this fork)                                                                     |

## Boundaries

```
caller --JWT + Idempotency-Key--> POST /work (eve custom channel "work")
   routeAuth(jwtHmac) -> FeltDB AgentTask (work_<sha256(requester, key)>, requireAbsent) -> from(workId).send()
                                        |
FeltDB (authoritative work)             |  eve (execution)
  _feltdb.AgentTask      head           |    session at address = workId, turns, tools,
  _feltdb.AgentCheckpoint history <-----+--  Workflow checkpoints (.eve/.workflow-data)
  appport_invocations    evidence <---- appport_invoke tool (from AppPort's response)
                                        |
                          AppPort host  |  traceId = workId; provenance: delegationId, decisionId, authority
```

| State                                                                                        | Authority                                                                     | Not authoritative for                                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Work: objective, requester, agent, status, progress, decisions, outcome, evidence references | FeltDB `AgentTask` + immutable `AgentCheckpoint`s, plus `appport_invocations` | —                                                                                      |
| Execution: session, turns, tool calls, resumption                                            | eve's Workflow world                                                          | Work status. A session is referenced from the work only as `execution.conversation_id` |
| Authorization and invocation provenance                                                      | AppPort host provenance plus AuthBoundry                                      | Work status. Joined by `requestId`, with `traceId` = work id                           |

## Phase 1: what FeltDB supports

Each row says whether the support was verified by running it here, or is only documented in `flow_db/docs`.

| Need                          | FeltDB facility                                                                           | Status in 0.22.0      | Verified here?                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| Durable records               | Collections with id and `__version` on the file runtime; writes acknowledged when durable | Stable                | Yes: records read back by a new process after `SIGKILL`                                               |
| Schemas                       | `defineStateContract`                                                                     | Experimental          | Not used                                                                                              |
| Atomic updates                | `db.transaction` with `requireAbsent`, `ifVersion` and record fences                      | Stable                | Yes, through agent state (create, version-fenced checkpoint)                                          |
| Idempotency                   | Transaction ids bound to payloads; Durable Work admission keys (server only)              | Stable / Experimental | Partly: idempotent admission comes from the derived task id and `requireAbsent`, and replay is tested |
| Append-only history           | `AgentCheckpoint` (immutable, one per version, with cumulative decisions and evidence)    | Experimental          | Yes: four checkpoints per completed work, read back without eve                                       |
| Query by id, status and owner | `getTask`; `listTasks({status, project})` on declared indexes                             | Experimental          | By id and by project, yes. There is no indexed query by requester (see gaps)                          |
| Concurrent updates            | `checkpoint` is fenced on the task head; a stale write is `VERSION_CONFLICT`              | Experimental          | Documented (`agent-state.test.mjs`). Not exercised here: one writer per work                          |
| Persistence and recovery      | File journal; owner lock (`STATE_LOCKED`); stale-lock recovery on `ESRCH`                 | Experimental          | Yes, including the lock finding below                                                                 |
| Verified evidence             | Record citations checked inside the checkpoint commit (`verified: true`)                  | Experimental          | Yes                                                                                                   |

**Why `openAgentState` and not Durable Work (`db.workloads`).** Durable Work has requester-scoped idempotency keys, approvals, `FAILED` and history. But it runs only against `feltdb-server`; the local runtimes reject it with `CONTRACT_UNSUPPORTED`. It also authorizes with FeltDB's own grant store and a worker claim and lease model. Using it would add a server and a second authorization system beside AuthBoundry. `openAgentState` is validated on the file runtime this single-host deployment uses, and it needs nothing new.

## Phase 2: the work representation

| Required             | Where it lives                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Stable work id       | `task_id = work_<sha256(requester \n key)[0..32]>`                                           |
| Requesting principal | `scope.workspace` (**mapping compromise**: `AgentTask` has no requester field)               |
| Agent identity       | `owner` = `agent:appport-agent`; checkpoint `actor`                                          |
| Application scope    | `scope.project` = `inventory`                                                                |
| Objective            | `objective`, immutable                                                                       |
| Status, timestamps   | `status`, `created_at`, `updated_at`                                                         |
| Progress summary     | Latest checkpoint `summary`; the full history in checkpoints                                 |
| Session association  | `execution.conversation_id` on the `turn.started` checkpoint; eve's address = work id        |
| Decisions, evidence  | Checkpoint `decisions` (cumulative, append-only) and `evidence` (record citations, verified) |

**Lifecycle**, using `AgentTask`'s own states:

| Required state | Represented as                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| accepted       | `ready` (checkpoint 1)                                                                                               |
| running        | `running`                                                                                                            |
| waiting        | `blocked` + decision `waiting: …`                                                                                    |
| failed         | `blocked` + decision `failed: the eve turn ended failed` (**mapping compromise**: `AgentTask` has no `failed` state) |
| completed      | `completed` (terminal)                                                                                               |
| cancelled      | `cancelled` exists in FeltDB; no route sets it (out of scope)                                                        |

The outcome rule is deterministic and uses recorded evidence, never the model's text:

- `completed` needs at least one authorized invocation;
- if every invocation was rejected, the work is `blocked` as waiting;
- if the turn failed, the work is `blocked` as failed;
- the agent's reply is kept in the summary, labelled as its reply.

## Evidence

Everything below runs in `examples/appport-agent/test/work.test.mjs` against real eve (`eve build` and `eve start`), FeltDB on disk, and the AppPort and AuthBoundry servers. The model is scripted with eve's `mockModel`, in a test agent generated from `agent/` with only `agent.ts` replaced.

| #   | Requirement                             | Test                                            | Observed                                                                                                                          |
| --- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One durable record per submission       | `creates one work record…`                      | `201`; history `ready → running → running → completed`; 4 distinct tasks for 4 distinct submissions, read from FeltDB without eve |
| 2   | Survives a restart                      | `keeps the work record…across an eve restart`   | Whole eve process group `SIGKILL`ed and restarted; the record is identical                                                        |
| 3   | A resumed session keeps its association | same                                            | `sessionId` (FeltDB) equals `liveSessionId` (eve's address lookup) after the restart                                              |
| 4   | Progress persisted                      | `creates…`, `is authoritative in FeltDB itself` | 4 immutable checkpoints, read by a separate process                                                                               |
| 5   | Failed work is accurate                 | `records a failed execution…`                   | `blocked`, `failed: the eve turn ended failed`, no evidence                                                                       |
| 6   | Completed work records its outcome      | `creates…`                                      | `completed`; the invocation outcome is `ok`; the summary carries AppPort's actual output (`quantity: 42`)                         |
| 7   | Same key does not duplicate             | `replays a repeated submission…`                | `200 replayed`, same work and session, no new checkpoint (also after the restart). A different objective gets `409`               |
| 8   | Alice cannot read Bob's work            | `does not let Bob read Alice's work…`           | `404`; Bob's same key yields his own work id                                                                                      |
| 9   | Provenance references the work          | `links AppPort's own provenance…`               | AppPort `traceId` = work id; `delegationId` = Alice's grant; `authority` recorded                                                 |
| 10  | Revocation still prevents invocation    | `does not invoke…once Alice revokes`            | `delegation_revoked`; no `execution` record; the work is `blocked`                                                                |

**Results:**

- The full suite passed twice in a row: 25 of 25, including the real-model suite. The key appeared 0 times in the logs, and no processes were left running afterwards.
- The work suite also passed in 7 more runs.
- **One earlier run failed and is unexplained.** In that run none of the agent's catalog lookups appeared in the AppPort host's provenance, so the AppPort-dependent work tests failed; the other tests passed. It hasn't recurred. Invocation error codes are now exposed in the work view, so a recurrence will show whether AppPort was unreachable or rejected the call.
- Mutation checks: removing the requester check fails 2 tests; making the id ignore the key fails 3.

## Findings

1. **Correction to earlier evidence: `eve start` runs the server as a child process.** `SIGKILL` to the CLI leaves the server orphaned.
   - The previous slices' restart tests killed only the CLI, so the old server survived beside the new one. Recovery there was still real, because the new process read durable state, but it was not a clean kill.
   - The tests now kill and await the whole process group. An operator's supervisor must do the same, as with AuthBoundry.
2. **FeltDB's exclusive lock blocks a fast restart.** The lock is recovered only when `kill(pid, 0)` returns `ESRCH`, and a killed but not yet reaped predecessor still answers.
   - The restarted agent got `STATE_LOCKED` on its first request.
   - The agent now retries the open for up to 10 s and no longer memoizes a failed open.
   - The lock also enforces one writer for the work store.
3. **`AgentTask` has no `failed` state and no requester field.** Both are mapped as described above. Durable Work has both, but needs a server.
4. **FeltDB agent-state scope is not authorization** (its docs say so). The `work` route enforces requester isolation, and there is no FeltDB policy on the file runtime.
5. **The AppPort client still drops `authorizationDecision`.** The delegation id therefore reaches the work through AppPort's provenance (`traceId` = work id, `requestId`), not inside the FeltDB invocation record.
6. **`@feltdb/core` adds about 0.67 MB of JS plus a 3.5 MB WASM asset** to the eve build output.

## Remaining recovery and operational gaps

- **No reconciliation of interrupted work.** Addressed in the next slice: see `DURABLE-WORK-RECOVERY-REPORT.md`.
- **No cancel, list or follow-up routes.** A completed task is terminal, so follow-ups to it are not modelled.
- **No indexed lookup by requester.** `listTasks` indexes status and project only.
- **Single eve process** per work store (the lock), the same as the local Workflow world.
- **Evidence verification is local.** `verified: true` proves the invocation record exists in this store. AppPort's provenance is the independent record, joined by `requestId`; nothing cryptographically binds the two.
- **The completion rule is this agent's policy.** "At least one authorized invocation" is deliberate and simple; richer outcome criteria are not modelled.
- **Earlier defects stand:** the AuthBoundry orphan and lack of a `dataDir` lock, and the AppPort client dropping decisions. They were not fixed, as instructed.

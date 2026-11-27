---
issue: "none: provider-neutral multi-session orchestration (durable child sessions)"
status: in-progress
last_updated: "2026-11-27"
---

# Provider-neutral multi-session orchestration

Goal: eve owns what a child session means: its identity, ownership, authority, delivery, completion, cancellation and recovery. Each execution host carries out those semantics with its own mechanics. An organizational eve on AppBoundry must coordinate children without Workflow and without weakening S8's application isolation.

This document covers the audit of eve2 main `067aba6` and AppBoundry main `6a0219a`, the contract, the authority rules, the chosen recovery design, and what is verified and what is not. **The slice is not complete.** Durable child recovery off Workflow and AppBoundry child execution are designed below, not yet implemented.

## Audit: how child sessions work today

- **Starting a child.** An `agent` tool call starts a task: a workflow-tool run of the framework body `serveAgentTool` (`runtime/subagents/workflow.ts`).
  - The run's first `receive()` gets the call, and `ctx.agent(name).send(message)` starts or reuses the child session, then awaits `result()`. `ctx.reply` sends the reply to the parent through the run-message protocol (`execution/tools/workflow/messages.ts`, applied by `SessionTurnHost.applyRunMessages`).
  - The task's hook token is deterministic: `eve:task:<sessionId>:<taskId>` (`execution/tools/workflow/start.ts`).
- **Durable records in the parent.**
  - Facts: `task.started {taskId, startedBy, kind: "agent"}`, `child.opened {sessionId, owner, name}`, and `child.sent {sessionId, childDeliveryId, callId}` per call.
  - State: the task table (`execution/tasks/table.ts`) holds the run address, pending calls and results.
- **Workflow.** The serve run is a Workflow run. Workflow journals and replays it, so a child's reply reaches the parent after a process dies. Remote agents (`execution/agent-sessions/steps.ts`) exist only here.
- **In-process.**
  - `execution/in-process/runs.ts` runs the same serve body in memory, with hooks opened `keep: KEEP_NOTHING`. Children are real sessions created through the host's own runtime (`localSessions.start` → `createSession`). Before the EVE stage below they were **not** persisted: `bootEntry` tracked only sessions owned by a person or by nobody, and a child's owner is `{ root }`. #51's first version of this document said otherwise, which was wrong.
  - The bridge is not: after a process dies, the parent never hears the child.
  - Remote agents and tools that start, send to or read other sessions are refused (`NO_STEP_RUNTIME`, `recordRemoteBinding`).
- **AppBoundry.**
  - The producer refuses the `agent` tool at build time (`packages/eve-appboundry`), because no host keeps a child durably.
  - In `sessions@1`, a session that does not exist yet is bound to the lane that first writes it, and every later access from another lane is `FORBIDDEN` (`appboundry-host/src/sessions.ts`, `#inLane`, `laneOf`). So a child created in lane `meetings.weekly` belongs to that lane. Child persistence therefore needs no `sessions@1` change, and lane isolation holds.
  - What is missing is execution. A child's turn runs in the background of the parent lane's instance, which the host may release as idle mid-turn. A scoped restore (`restore: { connection }`) restores the conversation's session but not the children in its lane.

## Verified

The session-host battery case: the process dies while an `agent` child works, and the parent must still hear the child's reply after restart. It runs under the declared capability `durableChildren`.

| Host                            | Result                                           |
| ------------------------------- | ------------------------------------------------ |
| Workflow (local world)          | pass                                             |
| in-process with a durable store | pass after the EVE stage below; it failed before |
| in-process                      | not durable, so skipped                          |

## Contract

The existing `Runtime` (`channel/types.ts`) is the cross-session contract: `createSession`, `dispatchSession`, `getEventStream`, `resolveContinuation`. eve adds no second session system. The child semantics eve owns:

1. **Identity.** A child is a session with its own durable id, never a new organizational eve. Its parent relation is recorded by the parent's `child.opened`. The host binds the child to the parent's owner: on AppBoundry the lane, otherwise the parent's session owner key.
2. **Delivery.** Work reaches a child only as a delivery whose id the parent records (`child.sent`). A delivery repeated with the same id is admitted once.
3. **Completion.** A child turn's settlement is durable in the child's stream. The parent's task call is settled at most once from it: settlement is idempotent by call and run.
4. **Cancellation.** Cancelling the parent's task cancels the child's turn (`cancel` command). Cancelling the parent session ends its working tasks and their children's turns. An ended child is never restarted.
5. **Recovery.** After a process dies, each working `agent` task is re-attached from the parent's durable records (below). No message is resent and no child work is repeated.
6. **Limitation reporting.** A host that cannot keep children durably says so: `durableChildren: false`, and a refusal that names the capability. It never silently degrades.

## Ownership and authority

| Identity               | Source                                             | A child                                                                         |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| organizational eve     | the deployment (`agent:org-eve`)                   | is the same eve, not a new identity                                             |
| application connection | the host's connection record (S8), from the caller | inherits the parent's connection; cannot name another                           |
| calling principal      | host authentication                                | none of its own: its deliveries come from the parent through the host           |
| acting person          | the verified per-delivery assertion (S8)           | inherits the parent's verified actor for that delivery; the model cannot set it |
| session                | the host, from the parent's owner or lane          | bound to the parent's lane or owner, unreachable by id from elsewhere           |
| execution identity     | the provider (`runId`)                             | provider metadata, never authoritative eve state                                |

Capabilities are checked at invocation as in S8: the connection's capabilities, then AuthBoundry `on_behalf_of` the actor at call time. A child's capability call passes the same check, so disconnect and revocation stay effective across restoration. A child receives only its task message and the parent's verified context for that delivery, not the parent's transcript.

## EVE stage: re-attach from durable facts (implemented)

No replay of the serve run, and no new session system.

### Persistence

- A child session is checkpointed like any session, with `ownerKey: { root }`.
- A scoped restore also restores the sessions rooted in what it restored.

### What restore does

For each restored parent, in `execution/in-process/runtime.ts` `restoreEntry`:

1. **Facts first.** Calls with a `call.settled` fact and tasks with a `task.ended` fact are dropped from the restored task table (`settledByFacts`). The event lines are committed before the checkpoint, so they are the settlement authority when the checkpoint lags.
2. **Open agent tasks.** A task with `kind: "agent"` that is not cancelled and has pending calls is adopted (`adoptAgentTasks`). Before the parent runs, the host records a fresh run on the task, under the task's deterministic hook token `eve:task:<session>:<task>`. A late message from the dead run then fails `isActiveTaskRun` and is dropped.
3. **Child link, in order:**
   - the parent's `child.sent` for the pending call;
   - else the child's own durable record: a session whose subagent adapter state names this parent and this call. That is needed because the parent can die before it applies the run's `agent-started` and `agent-sent` messages.
4. **Recovery** (`execution/in-process/reattach.ts`) re-opens the task hook and sends `started`. It then reads the child's stream with the same `turnSummary` that `Delivery.result()` uses, waiting until that delivery settles, and settles the parent's call through the existing run-message protocol:
   - **completed:** `reply` for the pending calls, then `outcome: completed`. A follow-up call that arrived meanwhile gets `outcome: failed` ("call without taskId to continue").
   - **failed or cancelled child turn:** `outcome: failed` with the same message a live serve run gives.
   - **`end` or `cancel` on the task hook:** cancels the child's turn, then `outcome: cancelled`.
   - **no link:** `outcome: failed`, saying eve could not confirm whether the agent received the message. No new child is created.
5. **Checkpointing parked messages.** The session program now checkpoints after applying a run message while parked (`execution/session/program.ts`), so a settlement a parked parent applies is durable. Workflow has no checkpoint sink, so this does not change its behavior.

### Settlement semantics

- **Child completed:** the child's `delivery.settled` and `turn.settled` in its own durable stream.
- **Reply delivered:** the parent's inbox received the run message. That is not durable by itself.
- **Call settled:** the parent's `call.settled` fact.

Recovery acts only when the parent's facts show no settlement. The parent applies a `reply` only for pending calls of the active run, and an `outcome` only for the active run. So a duplicate or late message, or a second recovery after another restart, settles nothing.

### Verified on the durable in-process host

Process death and restart, `internal/testing/session-host/child-recovery.integration.test.ts`:

- a running child, then two more restarts: the call settles once, there is one child, and the child received one delivery;
- a child that finished before the parent applied its reply;
- recovery itself interrupted by another restart;
- a child turn that fails;
- a parent cancelled during recovery: the child's turn is cancelled and the call is `interrupted`;
- a missing link: an explicit failure, and no new child.

### Not covered

- **Resuming the parent's own interrupted turn** is a pre-existing gap of the in-process host. A turn that resumed after waiting on its calls is checkpointed without `openTurn` (`execution/session/turn.ts`, the `paused` branch), so it is not resumed after a restart. Marking it open naively makes the retried step dispatch the task again, so it needs its own fix. The tests here assert settlement and no duplicate work, not the parent turn's completion.
- **Usage** a child spent before the restart is not re-counted by recovery.
- **A child turn awaiting a person's input** after the restart is not relayed to the parent: recovery waits.
- **Authored workflow-tool runs** remain D5.

## AppBoundry handoff (separate PR, not implemented)

The code it builds on: `appboundry-host/src/sessions.ts` (`#inLane`, `laneOf`), the agents@1 lane lifecycle in `appboundry-host/src/agents*.ts`, and `ArtifactHost` release and restore.

1. **The gap: background child execution in a lane.**
   - A child runs in the parent lane's guest instance as a background turn. agents@1 sees only the delivery that is running (`eve:deliver`), so after it returns the host can release the lane as idle, or the host process can die, with the child's turn and the parent's recovery pending.
   - Nothing restarts them until the next delivery to that lane.
2. **The smallest host operation: `agents.keepLane { until: "settled" }`.**
   - A guest-to-host request, made by eve's in-process host while a child turn or recovery is pending, plus a matching release.
   - The host persists, per lane, that work is pending (a host-owned record keyed by the lane the host assigned) and does not release the lane while it is set.
   - After a host restart, the host starts every lane with pending work, through the existing restore path that starts a lane's instance. The guest's `runtime.restore()` then restores the lane's sessions and re-attaches as above.
   - The guest never names a lane. The host takes it from the instance's own lane.
3. **Discovery after restart.** It needs no new index: children belong to the parent's lane by `sessions@1`'s first-write binding, and `readSessions(lane)` returns the lane's sessions.
4. **Isolation.**
   - `#inLane` already refuses any session of another lane (`FORBIDDEN`).
   - A lane belongs to one application connection (S8: the lane starts with `<application>.`), so a child cannot reach another application's sessions, even by id.
   - The pending-work record is keyed by the host's lane, so one lane cannot mark, discover or resume another's children.
5. **At host restart, per child state:**
   - **running:** the child's own open turn resumes in its restored session;
   - **completed:** recovery reads the settled turn from the child's stream;
   - **uncertain capability outcome:** reported, as in S7, and never resent.
6. **The producer** keeps refusing the `agent` tool until the host declares the operation. Then the two-application suite verifies children under S8 connections.

## Follow-up inventory (not implemented here)

| Feature                                   | eve owns                                                               | The provider owns                            | Workflow today                                                                                         | Needed elsewhere                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable timers (D5), delayed continuation | that a sleeping turn or task resumes at or after its deadline, once    | storing the deadline and waking the session  | Workflow `sleep`, `storedWaits`                                                                        | a deadline in the durable session record; AppBoundry `agents@1` `timer.sleep` extended to a host-kept wake after restart                                |
| Workflow-tool timer recovery              | that a run's sleep resumes after a restart, without repeating effects  | journaling a run                             | Workflow replay                                                                                        | either re-attach-style recovery for framework bodies or a host journal; authored bodies need idempotency declarations                                   |
| Schedules                                 | which sessions a schedule opens, and when; at most once per occurrence | firing the occurrence                        | `runtime/schedules/durable/*` through Workflow                                                         | a host cron or job capability (AppPort Services jobs, AppBoundry `jobs`) driving `dispatchSession`                                                      |
| Connection events                         | that an external event becomes a delivery to its owner session         | holding the event owner and its subscription | `DurableHost.connectionEvents` (Workflow)                                                              | a host-held owner record and a webhook route served by the host                                                                                         |
| Provider routes                           | none                                                                   | serving them                                 | `eve-channel/index.ts` mounts `/.well-known/workflow/*` webhooks and the stub-inspection routes always | mounted only when the installed durable host is Workflow; the host inventory (`framework/host-inventory.ts`) already tags them `capability: "workflow"` |

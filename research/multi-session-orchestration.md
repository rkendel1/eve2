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
  - `execution/in-process/runs.ts` runs the same serve body in memory, with hooks opened `keep: KEEP_NOTHING`. Children are real sessions created through the host's own runtime (`localSessions.start` → `createSession`), so with a `DurableSessionStore` the child session itself is persisted.
  - The bridge is not: after a process dies, the parent never hears the child.
  - Remote agents and tools that start, send to or read other sessions are refused (`NO_STEP_RUNTIME`, `recordRemoteBinding`).
- **AppBoundry.**
  - The producer refuses the `agent` tool at build time (`packages/eve-appboundry`), because no host keeps a child durably.
  - In `sessions@1`, a session that does not exist yet is bound to the lane that first writes it, and every later access from another lane is `FORBIDDEN` (`appboundry-host/src/sessions.ts`, `#inLane`, `laneOf`). So a child created in lane `meetings.weekly` belongs to that lane. Child persistence therefore needs no `sessions@1` change, and lane isolation holds.
  - What is missing is execution. A child's turn runs in the background of the parent lane's instance, which the host may release as idle mid-turn. A scoped restore (`restore: { connection }`) restores the conversation's session but not the children in its lane.

## Verified

The session-host battery has a new case: the process dies while an `agent` child is working, and the parent must still hear the child's reply after restart. It runs under a new declared capability, `durableChildren`.

| Host                            | Result                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| Workflow (local world)          | pass, about 3.3 s                                                      |
| in-process with a durable store | fails (the parent waits forever), so declared `durableChildren: false` |
| in-process                      | not durable, so skipped                                                |

The battery as a whole: 36 pass and 12 skip by declared capability; none fail.

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

## Chosen recovery design: re-attach from facts

No replay engine. On restore, for every working task with `kind: "agent"` in a restored parent's task table:

1. Find the child from `child.opened` (owner: the task's call) and the latest `child.sent` delivery for the task's pending call.
2. Read the child's stream for that delivery's turn:
   - If it has settled, send the parent the run messages `ctx.reply` would have sent (`reply`, then `outcome`), under the task's run id.
   - If it has not, follow the stream and do the same when it settles.
3. Open the task's deterministic hook token again, so cancellation reaches the child. A follow-up call with that `taskId` gets the existing "this task has ended; call without taskId" answer, and the task is marked not resumable.

Where it plugs in:

- `execution/in-process/runtime.ts` `restoreEntry`, after a session's checkpoint is restored;
- `execution/in-process/runs.ts` for the task's hook and run id;
- `execution/tasks/table.ts` for the working tasks;
- `execution/session-event-stream.ts` to read the child.

Authored workflow-tool runs stay outside this design (D5) and are reported as interrupted, as today.

## AppBoundry design

- **Persistence:** unchanged. Children belong to the parent's lane by `sessions@1`'s first-write binding.
- **Restore:** a scoped restore must also restore the sessions in the conversation's lane that the conversation opened as children. The lane already confines `readSessions`.
- **Execution:** an additive `agents@1` operation by which the guest declares lane work still pending (a child turn). The host keeps the lane warm until it settles, or resumes the lane after a restart. The host, not the guest, decides the lane. No cross-lane write is added.
- **Producer:** allow the `agent` tool once the host declares that operation, and verify it with the two-application suite. Application B's lanes and sessions stay unreachable from A's children, as `#inLane` already enforces.

## Follow-up inventory (not implemented here)

| Feature                                   | eve owns                                                               | The provider owns                            | Workflow today                                                                                         | Needed elsewhere                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable timers (D5), delayed continuation | that a sleeping turn or task resumes at or after its deadline, once    | storing the deadline and waking the session  | Workflow `sleep`, `storedWaits`                                                                        | a deadline in the durable session record; AppBoundry `agents@1` `timer.sleep` extended to a host-kept wake after restart                                |
| Workflow-tool timer recovery              | that a run's sleep resumes after a restart, without repeating effects  | journaling a run                             | Workflow replay                                                                                        | either re-attach-style recovery for framework bodies or a host journal; authored bodies need idempotency declarations                                   |
| Schedules                                 | which sessions a schedule opens, and when; at most once per occurrence | firing the occurrence                        | `runtime/schedules/durable/*` through Workflow                                                         | a host cron or job capability (AppPort Services jobs, AppBoundry `jobs`) driving `dispatchSession`                                                      |
| Connection events                         | that an external event becomes a delivery to its owner session         | holding the event owner and its subscription | `DurableHost.connectionEvents` (Workflow)                                                              | a host-held owner record and a webhook route served by the host                                                                                         |
| Provider routes                           | none                                                                   | serving them                                 | `eve-channel/index.ts` mounts `/.well-known/workflow/*` webhooks and the stub-inspection routes always | mounted only when the installed durable host is Workflow; the host inventory (`framework/host-inventory.ts`) already tags them `capability: "workflow"` |

---
issue: https://github.com/rkendel1/eve2/pulls
status: proposed
last_updated: "2026-11-26"
---

# Resumable session program

[`eve/experimental/host`](./host-independent-execution.md) runs eve's complete session runtime on any host, but only
as a warm instance: when the instance ends, its sessions end. Durable execution needs more than an instance.
Steps must be recorded, deliveries must survive restarts, timers must outlive the process, and effects must not
repeat. On Node, Workflow provides all of this.

This plan proposes `eve/advance`, which exposes the same session program as a function of recorded state.

- **What it is.** A host persists what eve asks it to and calls eve again. It can do this after a restart, on
  another machine, or in a fresh guest.
- **What stays in eve.** All orchestration stays in eve. The host runs no agent loop.
- **Relation to `eve/host`.** It does not replace `eve/host`. A host that needs only a warm instance keeps using it.

## API

```ts
import { advance } from "eve/advance";

let state = await advance(agent, { start: { sessionId, application, conversation } });
for (;;) {
  // state: { checkpoint, effects, wake, done }
  await store.save(sessionId, state.checkpoint); // durable before any effect runs
  const outcomes = await host.perform(state.effects); // model calls, tool calls, timers, deliveries out
  const inbound = await host.next(sessionId, state.wake); // outcomes, deliveries in, timer firings
  state = await advance(agent, { checkpoint: state.checkpoint, inbound });
  if (state.done) break;
}
```

- **`checkpoint`.** Plain, versioned data: the session's state, history, open calls, open interactions and child
  sessions. eve reads and writes it; the host stores it.
- **`effects`.** What eve needs done before it can continue, each with a stable id:
  - `model.call`;
  - `tool.call`, for tools whose execution the host owns;
  - `timer.set`;
  - `session.start`, for a subagent's child session;
  - `event.emit`, for session facts.

  eve never performs an effect itself.

- **`inbound`.** Effect outcomes keyed by effect id, deliveries (messages, approval answers, controls) and timer
  firings.
- **`wake`.** When eve next needs the host: a timer deadline, an awaited effect, or an awaited delivery.

## Semantics

- **Determinism.** `advance(checkpoint, inbound)` is a pure function of its inputs, apart from the effects it asks
  for. Replaying the same inbound against the same checkpoint produces the same checkpoint and the same effects.
- **At-most-once effects.** An effect id is stable across replays. A host that crashed after saving a checkpoint
  and before recording an outcome re-sends the same effect id. The application uses it to deduplicate, or the host
  reconciles it before retrying. eve never guesses an outcome.
- **Durable before effects.** A host saves the checkpoint returned with a set of effects before it performs any of
  them.
- **Subagents.** A subagent is a child session with its own checkpoint. Its completion is an inbound delivery to
  the parent, as it is under Workflow.
- **Approvals.** An interaction is part of the checkpoint. Its answer is an inbound delivery, and the call it
  approves becomes an effect only after the answer.
- **Versioning.** A checkpoint records the eve and compiled-agent versions that wrote it. eve refuses one it cannot
  read and names the versions.

## Boundaries

- The session program in `execution/session` becomes the single implementation behind Workflow, the in-process
  runtime, `eve/host` and `eve/advance`. Workflow becomes one host of it, not a separate path.
- Model and tool execution leave the program as effects. The code that performs them today moves into the Node
  host, unchanged in behaviour.
- `eve/host` continues to work. It becomes `eve/advance` plus an in-memory store and an in-process effect runner.

## Work required

- Separate effect requests from effect execution in the turn step, model calls and tool calls first.
- Define the checkpoint schema from the durable session state eve already serializes for Workflow, with a version.
- Run eve's Workflow parity suite against an `advance`-based host, including restarts at every effect boundary.
- Write a fault-injection suite that kills the host between checkpoint and outcome for each effect type.

## Out of scope

- A storage engine or scheduler. These belong to the host, for example FeltDB on AppBoundry.
- Authorization. Effects carry the delivery's `auth`, and applications decide.
- Changes to tool semantics, approvals or subagent behaviour.

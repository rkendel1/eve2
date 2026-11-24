---
issue: https://github.com/rkendel1/eve2/issues
status: proposed
last_updated: "2026-11-24"
---

# Agent control (`appport.agent-control/1`) for eve sessions

## Why

People steer a long-running agent: they say an update is coming, write it while the agent keeps working, and pause,
resume, interrupt or stop it, each with its own meaning. AppPort defines this as `appport.agent-control/1`
(`appport/spec/agent-control-1.md`), served over AppPort and MCP, with the `appport.agent.changed` event. FeltKit
already provides it for its own agent tasks. An eve agent that FeltKit hosts (`app.agent(name, { project })`) must
honour it fully: every operation, at real execution boundaries, durably, never enforced by the model.

The protocol splits responsibilities: the **provider** owns the lifecycle and its records (FeltKit), the **reasoner**
calls `checkpoint` before starting new work and `acknowledge`s updates (eve).

## Authoring API

One optional field on the agent definition. eve knows nothing about FeltKit; FeltKit supplies a controller.

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { feltkitControl } from "@feltdb/feltkit/agent";

export default defineAgent({ model, control: feltkitControl() });
```

```ts
interface AgentControl {
  /** Before each model step. `proceed: false` holds the turn durably until `resume` is sent to the session. */
  checkpoint(input: { sessionId: string; turnId: string }): Promise<{
    proceed: boolean;
    reason?: string;
    /** Updates to take into account now, oldest first; added to the model's input before the step. */
    instructions: ReadonlyArray<{ instructionId: string; text: string; from: string }>;
  }>;
  /** After the step that took them: what the agent made of each delivered update. */
  acknowledge(input: {
    sessionId: string;
    instructionId: string;
    outcome: "incorporated" | "conflict";
    note: string;
  }): Promise<void>;
}
```

A new session command, `POST /eve/v1/session/:id/resume`, re-drives a turn held by control. `cancel` (interrupt) and
`end` (stop) already exist.

## Semantics

```
person ──signal/submit/withdraw/pause/resume/interrupt/stop──▶ FeltKit (provider: records in FeltDB, events)
                                                                  │  interrupt ─▶ eve cancel   stop ─▶ eve end
                                                                  │  resume    ─▶ eve resume
eve turn ──before each model step──▶ control.checkpoint ──────────┘
   proceed: false  ─▶ the step returns held: { kind: "control" }; the session pauses durably (turn.paused, awaiting control)
   instructions    ─▶ appended to the step's input as updates from their senders; acknowledged after the step
FeltKit capability tools (actions) ─▶ refused at the bridge while paused/interrupted or an update is pending
```

- **Boundaries** are the model step (in `runStages`, before `runModelStep`) and every capability call (FeltKit's
  bridge, which already performs them). A signaled update never blocks.
- **Pause**: no new step or action starts; a model call or action already running finishes and is recorded
  (`pausing` until then). **Interrupt**: pause, and FeltKit cancels the running turn (`cancel`); a dispatched action
  finishes and its outcome is recorded. **Stop**: terminal; FeltKit ends the session (`end`); open updates are
  `abandoned`. **Resume**: FeltKit clears the mode and sends `resume`.
- **Updates** are delivered once, in order, at a checkpoint; a delivered update not acknowledged (the process died)
  is returned again by the next checkpoint. The agent acknowledges `incorporated` with a note after the step that
  took it; `conflict` pauses the task with the note as the reason.
- **Identity**: each eve session is one FeltKit agent task (`taskId` recorded with the session). Steering is
  authorized by FeltKit (people who may work with the agent in the session's workspace); `checkpoint` and
  `acknowledge` only by the agent (the bridge's service key).

## Invariants and tests

- No model step starts while the task is paused, interrupted or has a received, undelivered update.
- A held turn survives a restart and continues from `resume` exactly once.
- Every delivered update reaches the model input exactly once per delivery and is acknowledged.
- eve without `control` behaves exactly as before.

Tests: eve unit tests for the hold and the input of updates (a scripted model); FeltKit integration tests over HTTP,
AppPort and MCP against a running eve agent with the deterministic model; SaaSKit's browser walkthrough uses the
composer and bar.

---
issue: "none: Handoff worker-runtime gap register (no tracking issue yet)"
status: implemented
last_updated: "2026-11-23"
---

# Work channel

`workChannel` (`eve/channels/work`) and `createWorkClient` (`eve/channels/work/client`) give an
external orchestrator one versioned surface to run an eve agent as a worker: submit work, steer
it, interrupt or stop it, follow its events from a durable cursor, and read its result. Usage is in
`docs/channels/work.mdx`; this note records the decisions.

## Why a channel, not an extension

The surface is HTTP routes plus session-event handlers, which is what a channel is. Extensions
contribute tools, skills, and instructions to the model; none are needed here. Shipping it as a
built-in channel factory, like `a2aChannel` and `mcpChannel`, keeps it in the `eve` package with no
new runtime dependency. AppPort, FeltDB, and AuthBoundry stay in the application:
`examples/appport-agent` mounts `workChannel` as `agent/channels/worker.ts` for orchestrators and
keeps its FeltDB-backed `/work` routes for the AppPort operation ledger and settlement, which are
domain rules rather than worker-runtime contracts.

## Model

| Work concept      | eve                                                                         |
| ----------------- | --------------------------------------------------------------------------- |
| work              | one session, created as an external invocation owned by the caller          |
| work id           | the session id (`wrun_…`), readable after the session ends                  |
| idempotency key   | hashed with the owner into the session's continuation token                 |
| submission digest | a run attribute, so a replayed key is checked without reading the stream    |
| attempt           | one turn (`turnId`)                                                         |
| runner            | `session.started` runtime identity: agent id, eve version, build            |
| cursor            | the next stored stream line, the same `startIndex` the session stream takes |

Nothing is stored beyond the session: status and result fold the session stream, as A2A does. Two
instances that share one Workflow world share the work, because every read and write goes
through the world.

```
POST /eve/v1/work (Idempotency-Key)   -> new owner+key: create session, 201
                                      -> same key, same digest: 200 replayed, nothing runs
                                      -> same key, other digest: 409 idempotency_key_reused
POST /:id/messages                    -> send(turnPolicy: "steer")
POST /:id/interrupt                   -> cancel(turnId?)
POST /:id/stop                        -> cancel, then end
GET  /:id, /:id/result, /:id/events   -> fold or proxy the session stream
```

## Controls are declared, not faked

Every submission and status carries `controls`, one entry per control with `supported`,
`preemptsModelStep`, and `preemptsToolStep`:

- `interrupt` and `stop` abort the streaming model call and every tool call's abort signal; sandbox
  commands are killed. Effects a tool already caused are not undone.
- `steer` never aborts a model call; it ends workflow-tool waits through their abort signal.
- `pause` and `resume` are `supported: false`. A Workflow turn can't be suspended mid-step and
  continued from the same point, so eve does not pretend to. The next message starts a new
  attempt with the conversation so far.

## Workspace and results

A submission may name a `repository` (`url`, `ref`, `branch`) on an allowlisted host. In
`turn.started`, before the first model call, the channel fetches it into the sandbox's workspace
root. Credentials never appear in the URL; private repositories rely on the sandbox's network
policy (Vercel credential transforms). A failed checkout is recorded, and the model is told to stop
if the workspace isn't the checkout, because a channel handler can't fail the turn.

When an attempt settles, `onResult` receives `WorkResult` plus `workspace`: root, branch, commit,
base commit, dirty flag, and changed files. These come from the sandbox, which only in-session code
can reach, so `GET /:id/result` returns the stream-derived part only. `onResult` runs at least once
per attempt and can commit or upload the workspace through `ctx.getSandbox()`.

## Runtime separation

The server needs Node.js 24, like the rest of eve. The client entry imports nothing at runtime and
needs only `fetch`, so a Node.js 22 process can drive an eve worker over HTTP. A unit test keeps
the client free of runtime imports.

## Limits

- Idempotency holds while the session keeps its address: after `stop` or the session timeout, the
  key may start new work.
- `pause`/`resume`, per-attempt egress allowlists on Docker sandboxes, and brokered credentials
  outside Vercel sandboxes are not provided.

---
issue: https://github.com/rkendel1/eve2/pulls
status: proposed
last_updated: "2026-11-25"
---

# Host-independent execution

eve runs its agents on Node: Workflow drives durable turn steps, and Nitro serves the session protocol. An
organization's agent should be able to run on any host that can execute JavaScript, such as a Wasm guest, without a
second agent implementation and without belonging to whichever application first connected it.

This plan:

- exposes eve's existing durable turn step to such hosts;
- states the platform boundary eve's core must keep;
- records how one organizational agent serves many applications.

## Evidence

`rkendel1/appboundry` `experiments/eve-guest-spike` (Step 0) ran eve 1.1.2's unmodified kernel inside FeltKit's Boa
Wasm engine. The engine has no imports, so it has no I/O of its own.

- **Model:** a real model, reached through the host.
- **Capability:** a real application capability, reached through the host and authorized by the application.
- **Context:** async context held across out-of-order host round trips, with negative controls.

It also measured what stands in the way:

- the turn step's static imports reach 6.7 MB of hosting code (sandbox, Workflow, `undici`, `rolldown`, model auth);
- several core modules do Node work as they load;
- `AsyncLocalStorage` has no equivalent in the guest.

None of this is agent behaviour.

## API

A new experimental entry, `eve/host`:

```ts
import { createSessionHost } from "eve/host";

const eve = createSessionHost({
  artifacts, // BundledCompiledArtifacts from `eve build`: the organization's agent, unchanged
  models: { resolve: async (reference) => languageModel }, // the host performs model calls and holds credentials
  events: (sessionId) => writable, // WritableStream<Uint8Array> of the session's facts (eve's session lines)
});

const opened = await eve.open({ sessionId, connection, auth }); // establish a session for one connection
let step = await eve.step({ ...opened, input: { delivery } }); // one durable turn step
while (step.action === "continue") step = await eve.step({ ...step, input: undefined });
// step.action: "paused" | "parked" | "done" | "cancelled"; step carries the next checkpoint
```

- **`artifacts`.** The same compiled agent `eve build` produces for Node: instructions, tools, skills and model
  definitions. A host embeds it; nothing is read from disk.
- **`models.resolve(reference)`.** Returns an AI SDK `LanguageModel`. The host decides what a model reference means
  and makes the provider call. eve never sees the provider credential.
- **`open`.** Returns the first checkpoint: `sessionState`, `serializedContext` and an empty `history`.
- **`step`.** Exactly eve's `turnStepOn` contract:
  - in: a checkpoint plus an optional `delivery` (a message, answers to an approval, runtime results, or a control);
  - out: `DurableStepResult`, which is the next checkpoint and an `action`.

  `continue` means "call again". `paused` and `parked` wait for a delivery. `done` and `cancelled` end the turn.
  Cancellation is a `control` delivery or the step's `abortSignal`.

- **Durability.** The checkpoint is plain data. Storing it, scheduling the next step, and retrying a step whose
  outcome is unknown all belong to the host.

Tools are the agent's own definitions, run by eve's call executor. A tool reaches the outside world through
whatever its definition uses. For an application's capability, that is the application's transport, which the host
provides to the tool. eve adds no application-specific path. Anything a host cannot provide fails when it is used,
and the error says so:

- subagents and background tasks (`createRuntime`);
- sandbox and file tools;
- network fetch.

## Platform boundary

These rules are checked by a guard. The guard bundles the `eve/host` entry for a neutral platform and fails on any
violation.

1. **No Node built-ins at load.** Nothing reachable from `eve/host` imports a Node built-in at module load.
   - A Node-only implementation sits behind `#platform/*` package imports with `node` and `default` conditions.
   - The `default` condition implements the same behaviour without Node, or throws on use, naming the missing host
     capability.
2. **Hosting at first use.** Hosting-only dependencies are loaded when first used, never at module load. These are
   Workflow, the sandbox, `undici` (web fetch), model-provider auth and authored-module loading.
3. **No I/O at load.** No module reads files or inspects the environment when it loads. The package version is
   stamped at build.
4. **Neutral vendored code.** Vendored dependencies on this path are built for a neutral platform.
5. **Network policy on the host.** SSRF ranges and destination checks run where the network is, and are built on
   first use.

On Node, every `#platform` import resolves to today's implementation, so behaviour is unchanged.

## Async context

eve keeps session state in an async context: `contextStorage`.

- **On Node:** it is `AsyncLocalStorage`.
- **Elsewhere:** it is the TC39 `AsyncContext.Variable` the host installs.
- **If neither exists,** `createSessionHost` throws.

A host that provides `AsyncContext` must propagate it per continuation. Step 0's implementation and its tests,
including the negative controls, define what that means:

- the context survives awaits and host round trips;
- concurrent sessions never see each other's context;
- a nested run restores its parent's context.

The implementation belongs to the host's guest build (for AppBoundry, FeltKit's guest target), which also lowers
`async`/`await` so continuations go through `Promise.then`. eve does not patch globals.

## The organization's agent and the applications that connect to it

| Concept                                                 | Owner                                                                      | What eve does with it                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Organization                                            | the platform (AuthBoundry tenant)                                          | nothing                                                                            |
| The organization's agent: identity, instructions, tools | the organization; one compiled agent                                       | runs it: one `artifacts`, every connection                                         |
| Application connection                                  | the connecting application                                                 | records it on the session (`eve.connection`: `{ application, kind, ref }`) as data |
| Person asking                                           | identity provider; the application forwards an assertion the host verifies | `auth.current` / `auth.initiator`, as given                                        |
| Delegated authority, approvals                          | AuthBoundry / AppPort grants                                               | carries the reference in `auth` attributes; the application decides each call      |
| Task and application context                            | the connecting application                                                 | the delivery's message and attachments                                             |
| Session, turns, checkpoints                             | the organization's agent                                                   | owns and executes them                                                             |
| Result and evidence                                     | the session's facts, and the application's records of each call            | emits facts; never rewrites them                                                   |

Invariants:

- **A connection grants nothing.** Being connected lets an application deliver work to a session it opened. It never
  widens what any tool may do. eve has no authorization decision of its own: a capability call succeeds or fails
  where the application authorizes it.
- **One agent, many connections.** Two applications open two sessions on the same `artifacts`. Neither can read,
  answer or cancel the other's session through eve. There is no per-application copy of the agent.
- **The agent's identity is not an application's.** `eve.connection` names who asked, not who the agent is.

## Out of scope

- A durable run store and step scheduler; these are the host's.
- Subagents, background tasks and sandbox tools under `eve/host`. They fail with a message naming what is missing.
- Changes to the agent loop, tool semantics or approvals.

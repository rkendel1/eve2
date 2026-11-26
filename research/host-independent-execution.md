---
issue: https://github.com/rkendel1/eve2/pulls
status: proposed
last_updated: "2026-11-26"
---

# Host-independent execution

eve runs its agents on Node: Workflow drives durable turn steps, and Nitro serves the session protocol. An
organization's agent should also run on any host that executes JavaScript, such as a Wasm guest. It should not need
a second agent implementation, and it should not belong to whichever application connected first.

This plan:

- adds `eve/experimental/host`, which runs eve's complete session runtime on a host's infrastructure;
- states the platform boundary eve's core keeps;
- records what is durable and what is not;
- records how one organizational agent serves many applications.

It is a warm-instance execution model. Durable, resumable execution is a separate proposal,
[resumable session program](./resumable-session-program.md).

## API

```ts
import { createEveHost } from "eve/experimental/host";

const eve = createEveHost({
  agent, // the compiled agent eve's compiler writes: manifest, module map, model metadata
  models: { resolve: (reference) => languageModel }, // optional: the host resolves every model reference
});

const meeting = eve.connect({ application: "meetings", conversation: "weekly-sync" });
const accepted = await meeting.send("Summarize the decisions.", { auth });
const result = await accepted.result(); // { status, reply, interactions, sessionId, ... }
await meeting.deliver({ answers }, { auth }); // answers to approvals
await eve.idle();
await eve.dispose();
```

- **`agent`.** The organization's agent as eve compiles it for Node. A host embeds it; nothing is read from disk.
- **`models.resolve(reference)`.** Returns an AI SDK `LanguageModel` for the agent's (or a subagent's) model
  reference. With it, the host owns every model choice and provider call, and eve never sees a provider credential.
  The agent's own model definitions do not run. Without it, eve resolves models as it does on Node.
- **`connect({ application, conversation })`.** An address for one conversation of one application. It is eve's
  channel address: the application is the channel name, and the conversation is its continuation token. `send`
  delivers a message, `deliver` answers approvals, and `result()` reads the turn's outcome.
- **`runtime`.** eve's `Runtime` contract (sessions, commands, session and line streams) for hosts that need more.
- **`idle()` / `dispose()`.** Wait until no session has work in flight, and stop every session.

## Ownership

| Responsibility                                                                                                         | Owner |
| ---------------------------------------------------------------------------------------------------------------------- | ----- |
| Session lifecycle, the agent loop, model and tool decisions, subagent dispatch and completion, approvals, finalization | eve   |
| Model transport and provider credentials (`models.resolve`)                                                            | host  |
| Capability execution: the network the agent's tools reach (`fetch`)                                                    | host  |
| Timers and macrotasks (`setTimeout`, `setImmediate`)                                                                   | host  |
| Async context propagation (`globalThis.AsyncContext`)                                                                  | host  |
| Persistence of session facts, and delivery of events to applications                                                   | host  |

`createEveHost` wraps eve's in-process runtime, the same runtime eve tests against Workflow for parity. There is
one agent loop: `runPreparedSession` performs turns, tool calls, approvals, subagents, timeouts and finalization
exactly as it does under Workflow.

## Platform boundary

A guard (`pnpm --filter eve check:host-neutral`, run by `pnpm build`) bundles these entries for a neutral platform
and fails on any Node built-in or hosting-only package (Workflow, Nitro, `undici`, `rolldown`) on their static graph:

- `eve/experimental/host` and the durable turn step;
- what every compiled agent imports: `eve`, `eve/tools`, `eve/tools/approval`, and the module map's loader.

The rules:

1. **No Node built-ins at load.** A Node-only implementation sits behind a `#platform/*` package import with `node`
   and `default` conditions. The `default` condition implements the same behaviour without Node, or throws on use,
   naming the missing host capability.
2. **Hosting at first use.** Workflow's runtime, the sandbox, development prewarm, Vercel OIDC, model-provider auth
   and authored-module loading are imported when first used, never at module load.
3. **No I/O at load.** No module reads files, resolves packages or inspects the environment when it loads. The
   package version is stamped at build.
4. **Neutral vendored code.** Vendored dependencies on these paths are built for a neutral platform.

On Node, every `#platform` import resolves to today's implementation, so behaviour is unchanged.

The framework modules every module map loads at startup (the default `eve` and `home` channels and the default
sandbox) still import Node built-ins statically, but run no Node code at load. A guest can therefore bundle them
with throw-on-use stand-ins. Making them neutral is follow-up work.

## Async context

eve keeps session state in an async context.

- **On Node:** it is `AsyncLocalStorage`.
- **Elsewhere:** it is the TC39 `AsyncContext.Variable` the host installs. Without one, eve throws when it loads,
  and the error says what to install.

The host's implementation must propagate context through every promise continuation:

- context survives awaits and host round trips;
- concurrent sessions never see each other's context;
- a nested run restores its parent's context.

## Durability

Without a `store`, this interface is a warm instance: nothing it holds survives the instance. With
`createEveHost({ store })`, sessions survive the host (see [resumable session program](./resumable-session-program.md)).

| State                                               | Without a store   | With a store                                                                  |
| --------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| The compiled agent                                  | the host's bundle | the host's bundle                                                             |
| Session facts (the session line stream)             | instance memory   | the store; each line is durable before eve continues                          |
| Session state, history, pending approvals           | instance memory   | the store, checkpointed at each turn start, step, approval wait and idle wait |
| Subagent child sessions, workflow-tool runs, timers | instance memory   | instance memory: not restored                                                 |
| Effects a tool performed                            | the application   | the application; eve records each call's start before it runs                 |

- **Host terminated mid-turn, with a store:** a new host on the same store restores the session at its last checkpoint
  and reruns the interrupted step as a retry. Calls whose outcome was recorded are adopted; a call that started without
  a recorded outcome is reported to the model as one that may or may not have taken effect, and is not run again.
- **Resumption:** the same `connect({ application, conversation })` reaches the restored session.

## The organization's agent and the applications that connect to it

| Concept                                                 | Owner                                                    | What eve does with it                                                      |
| ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Organization                                            | the platform (AuthBoundry tenant)                        | nothing                                                                    |
| The organization's agent: identity, instructions, tools | the organization; one compiled agent                     | runs it: one `createEveHost`, every connection                             |
| Application connection                                  | the connecting application                               | a channel named for the application; its conversations are its own         |
| Person asking                                           | identity provider; the application forwards an assertion | `auth` on each delivery, as given                                          |
| Delegated authority, approvals                          | AuthBoundry / AppPort grants                             | none of its own: each capability call succeeds or fails in the application |
| Task and application context                            | the connecting application                               | the delivery's message and attachments                                     |
| Session, turns, approvals, subagents                    | the organization's agent                                 | owns and executes them                                                     |

Invariants:

- **A connection grants nothing.** Connecting lets an application deliver work to its own conversations. It never
  widens what any tool may do. An approval answered in eve lets eve run the call; the application still authorizes
  it.
- **One agent, many connections.** Two applications get separate sessions of the same agent. A conversation token
  is scoped to its application's channel, so one application cannot address another's session.
- **The agent's identity is not an application's.** The connection names where work came from, not who the agent is.

## Evidence

`rkendel1/appboundry` `experiments/eve-host-boa` runs `eve/experimental/host` from eve's built dist inside FeltKit's
Boa Wasm engine, which has no imports. The host supplies `AsyncContext`, timers, `fetch` and model calls as host
operations.

- **Static graph:** no Node built-ins.
- **Sessions:** two applications, approval and denial, a declared subagent, and model failure, against a scripted
  model. A Node run of the same scenarios gives the same results.
- **Capability:** a real application capability, authorized by the application. A call a person approved but the
  grant did not cover was refused by the application.
- **Credentials:** the host's executor key never appeared in guest memory.

The guest's cold load is about 40 seconds: Boa parses a 12 MB bundle that includes lazily loaded hosting code. A
warm turn takes about 0.3 seconds.

## Out of scope

- Durable runs, crash recovery and resumption (see the [resumable session program](./resumable-session-program.md)).
- Sandbox tools under a host without a sandbox provider. They fail when used.
- A command that writes only the compiled agent for a host. Hosts call eve's compiler today.
- Changes to the agent loop, tool semantics or approvals.

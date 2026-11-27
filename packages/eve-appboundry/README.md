# @eve/appboundry

Internal, unpublished. Produces the organization's eve agent as an AppBoundry application artifact
(`appboundry.app/1`): the agent's compiled form, bundled as a guest program for FeltKit's Boa engine, in the format
FeltKit's `--target appboundry` writes and AppBoundry's host loads. Roadmap slice S6
([research/organizational-eve-roadmap.md](../../research/organizational-eve-roadmap.md)).

## Command

```sh
node packages/eve-appboundry/src/cli.mjs build <app> --out <dir> --engine <engine.wasm> [--report <file>] [--json]
```

- `<app>` is the agent's app root: `agent.ts` (or `agent/`), its tools, and `appboundry.json`.
- `--engine` is FeltKit's guest engine, `appboundry/engine.wasm` in `@feltdb/feltkit` (0.5.4 has sha256
  `4d4b62d7…66bc4`). `EVE_APPBOUNDRY_ENGINE` can supply it instead. eve does not depend on FeltKit, because FeltKit
  depends on FeltDB, so the engine is an input file.
- Exit codes: 0 built, 1 refused (`error <CODE>: <reason>` on stderr), 64 usage.

### Prerequisites

- eve built (`pnpm --filter eve build`); the producer runs the eve the app resolves, and its compiler.
- The app's dependencies installed.
- `appboundry.json` at the app root:

```json
{
  "application": { "id": "org-eve", "name": "Organization eve", "version": "1.0.0" },
  "requires": [
    { "name": "repo.changes.get", "versions": "1", "purpose": "Reads a prepared change" }
  ]
}
```

It names the one organizational eve and the application capabilities its tools call. eve's compiled agent has no
notion of AppBoundry capabilities; a tool calls one through `https://capabilities.invalid/invoke` (see
`fixtures/minimal-agent/lib/capability.ts`), and the guest turns that into `capability.invoke`. AppBoundry refuses any
capability the manifest does not require, and the operator binds and grants each one.

### Output

- `<dir>/module.wasm`: the engine, byte for byte, plus one custom section `appboundry.program` with the program
  (UTF-8 JavaScript).
- `<dir>/manifest.json`: see below.
- `<dir>.report.json`, beside the artifact and not part of it: sizes, every kept and stubbed module and why, each
  tool's module and Node built-ins, the Node built-ins anywhere in the bundle. It is also written when a build is
  refused for its tools.

The same inputs give the same bytes. One input is the AI Gateway model catalog, which eve's compiler embeds with the
time it read it (`fetchedAt`, in the report's `modelCatalog`). A build that refreshes it differs from one that did not.
Set `EVE_MODEL_CATALOG=bundled` to build with the catalog bundled with eve, for byte-identical rebuilds. The program
names no build-machine path: the app root becomes `/appboundry/agent`.

## The manifest

| Field                | Value                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application`        | from `appboundry.json`                                                                                                                                         |
| `producer`           | `eve-appboundry` and the eve version                                                                                                                           |
| `functions`          | `eve:deliver { session, conversation, message, assertion? }` and `eve:answer { …, answers }`: actions with `agent: { session: "session", actor: "assertion" }` |
| `runtime.interfaces` | `actions@1`, `agents@1`, `connections@1`, `identity@1`, `model@1`, `sessions@1`; `capabilities@1` when `requires` is not empty                                 |
| `requires`           | from `appboundry.json`                                                                                                                                         |
| `identity.roles`     | `member: ["eve.deliver"]`; both functions need `eve.deliver`                                                                                                   |
| `permissions`        | no collections, services, network or filesystem                                                                                                                |
| `omitted`            | what the agent configures that the artifact does not carry: the model (a reference; the deployment binds it), the sandbox, eve's channels                      |

A delivery's `session` must be `<application>.<conversation>`, where `<application>` is the connection the host
matched to the caller (connections@1), so agents@1 serializes each conversation on its own lane. The guest refuses any
other value, and no argument names the application. eve's `auth` is the person the host verified from `assertion`, or
else the principal the host authenticated, never an argument.

How the guest uses each interface:

- **sessions@1** holds eve's session store: `appendLine`, `readLines`, `saveSession`, `readSessions`.
- **model@1** answers every model call with `model.generate`, against the model the deployment binds.
- **capabilities@1** carries the tools' capability calls, keyed `${session}:${callId}`. An `unknown` outcome reaches
  the model as "may or may not have taken effect".
- **timer.sleep** (agents@1) runs eve's timers, on the guest's own clock.

The clock matters because the host performs an action's requests one at a time and answers them together. A timer
issued beside other work, such as the 10-minute timeouts eve races against model calls, would hold that work's
answer for its whole length. So a timer is a deadline the guest checks whenever it runs. The guest asks for a single
`timer.sleep` to the nearest deadline (at most the host's 60 s) only when nothing else is outstanding.

## What the agent's tools do to the bundle

The bundle is one script, so everything in it is parsed and evaluated at every cold start. A module eve loads only on
demand (`import()`) is bundled only when kept. Otherwise it is a stub that throws, naming itself, when imported. A
module reached through a static import is never stubbed.

The keep list is derived, not configured:

1. **The host base**, which every agent needs. `definitions/compiled-agent.js` is loaded for every session turn.
   `execution/sandbox/ensure.js` is loaded by the sandbox context provider on every turn.
2. **Every eve source the compiled agent's module map loads**: its sandbox, its channels, its default and framework
   tools. They are read from `.eve/compile/module-map.mjs` and mapped to modules through eve's framework registry
   (`framework/sources/registry.js`, `default-tools.js`). A source the registry does not name fails the build.

Each tool is then checked on its own module closure, and refused (`TOOL_UNAVAILABLE`) when the model could call it but
it could not run on AppBoundry:

- its code needs a Node built-in the guest lacks;
- it is one of eve's own tools (found through eve's `eve/tools/<name>` exports and its framework registry) that is not
  verified on AppBoundry's production host. Only `ask_question` and `no_reply` are; each other tool is refused with
  what it needs;
- it is a provider tool (`behavior.handling.kind: "provider-tool"`), which runs inside the model provider's call.

The error names each tool and its reasons, and says how to remove it. eve's turn path, the entry's static graph short
of the tools, may import no unimplemented built-in either. Tools the agent authors, such as the capability tools in the
fixtures, are the author's; they reach other systems through `capabilities@1`.

### eve's built-in tools on AppBoundry

`test/tools.test.mjs` builds an agent with each tool and checks the producer's decision; the two verified tools also
run on the production host there.

| Tool                                                   | On AppBoundry                              | What it needs                                                                     | Owner of the missing piece                                                                              |
| ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ask_question`                                         | supported, verified on the production host | nothing more: `eve:answer` carries the answer                                     |                                                                                                         |
| `no_reply`                                             | supported, verified on the production host | nothing more                                                                      |                                                                                                         |
| authored tools calling capabilities                    | supported, verified on the production host | `capabilities@1` (exists), declared in `appboundry.json`                          |                                                                                                         |
| `bash`, `read_file`, `write_file`, `edit_file`, `glob` | refused at build time                      | a sandbox, and `node:crypto` / `node:path` in its code                            | a new AppBoundry sandbox (workspace) capability, and an eve sandbox binding for it                      |
| `grep`                                                 | refused at build time                      | a sandbox                                                                         | as above                                                                                                |
| `web_fetch`                                            | refused at build time                      | network access, and `node:dns` for its destination check                          | none needed: other systems are reached through `capabilities@1`; a fetch capability is an application's |
| `web_search`                                           | refused at build time                      | a provider tool run inside the model call                                         | `model@1` (AppBoundry): it would have to run provider tools                                             |
| `agent`                                                | refused at build time                      | a child session per call, which the host does not keep durably                    | eve (roadmap D5: durable child sessions), then verification on AppBoundry                               |
| `sleep`                                                | refused at build time                      | the Workflow runtime (`node:async_hooks`, `node:crypto`, `node:url`, `node:util`) | eve: a host-timer implementation of workflow waits                                                      |
| `eve__search`, `eve__tool`, `eve__skill`               | not built or verified                      | deferred tools, connections or skills; connections reach the network              | not assessed in S7                                                                                      |
| `workflow`, `agent_router`                             | not built or verified                      | the Workflow runtime, as `sleep`                                                  | eve                                                                                                     |
| declared subagents                                     | verified only in the experiment harness    | in-process child sessions                                                         | verification on the production host                                                                     |

## Verify and inspect

AppBoundry 1.15.0 on npm predates `agents@1`, `sessions@1` and `model@1`. Until a release serves them, use a built
checkout of `rkendel1/appboundry`:

```sh
node <appboundry>/packages/appboundry/dist/bin.js artifact verify <dir>
```

```sh
node <appboundry>/packages/appboundry/dist/bin.js artifact inspect <dir>
```

`verify` checks the hashes and the program section. It then loads the program in the guest under the host's limits
and checks that it describes exactly the manifest's functions.

## Tests

```sh
EVE_APPBOUNDRY_ENGINE=<engine.wasm> APPBOUNDRY_CHECKOUT=<appboundry> pnpm --filter @eve/appboundry test
```

- `test/producer.test.mjs` (the engine): the section format, the declaration, the keep derivation, the manifest, no
  Node built-in on the turn path, no credential or build-machine path, the refusals, byte-identical rebuilds.
- `test/tools.test.mjs` (the engine; the checkout for its second part): the tool inventory above.
- `test/appboundry.test.mjs` (the engine and the checkout): AppBoundry's `parseManifest`, `artifact verify` and
  `artifact inspect`; refusal of `agents@2`, of a missing `agents@1` or `actions@1`, and of functions that differ
  from the program.
- `test/host.test.mjs` (the engine and the checkout): deliveries, a capability call, an approval, an uncertain outcome,
  restore by a new host, refusal of a mismatched session and of an unpermitted caller.
- `test/lifecycle.test.mjs` (the engine and the checkout): the production lifecycle below, in real host processes.
- `test/connections.test.mjs` (the engine and the checkout): two applications connected to one eve, in a real host
  process with the real AuthBoundry (`@authboundry/local`); see [Applications and acting identity](#applications-and-acting-identity).

Without those variables the suites that need them are skipped, naming the variable. eve's CI does not set them yet.
`test/measure-host.mjs` measures the production host path.

## Operating it on AppBoundry

Deploy only the artifact directory, `manifest.json` and `module.wasm`. The host needs AppBoundry with `agents@1`,
`sessions@1`, `model@1` and `capabilities@1`, and FeltKit's engine is already inside `module.wasm`. Neither the eve
repository, pnpm, eve's compiler, FeltKit nor the build workspace is needed.

```sh
node <appboundry>/packages/appboundry/dist/bin.js artifact verify org-eve.app
```

The deployment binds what the artifact only names:

- **the model**, `ArtifactHost.open({ modelBinding })` or `appboundry run --model`: provider, protocol, model,
  endpoint, credential and allowed hosts;
- **each required capability**, `capabilityBindings`: the provider application, its URL, the credential and the grant;
- **the warm window**, `--agent-idle-ms` (default 60 000).

Each conversation is one session lane (`<application>.<conversation>`), on its own instance. The guest creates eve with
`restore: { connection }`, so a new instance restores only its conversation's session. The host scopes `sessions@1`
to the lane, so the instance cannot read, list or change any other. A stored session the guest cannot restore is
refused (`SESSION_UNRESTORABLE`) and left as it was. The delivery that starts an instance reports
`start: { loadMs, restoreMs, restored }`. The guest's clock advances with each host step, so a time inside one step
reads 0.

`test/lifecycle.test.mjs` runs, in real host processes from a directory holding only the two files:

1. install and verify the artifact;
2. open the host, deliver to a new session and continue it;
3. call a capability and wait for an approval;
4. release the idle instances, and restore a session on its next delivery;
5. `SIGKILL` the host with a capability call in flight and the approval pending;
6. restart and restore only the session delivered to: the in-flight call is reported as uncertain and not repeated,
   and no other conversation reaches the model;
7. find the other sessions' records unchanged, by FeltDB record version;
8. answer the approval after the release and the kill: the call runs once;
9. close cleanly, then find every acknowledged line stored and every conversation continuing.

It also covers:

- two sessions running independently;
- deliveries to one session serialized, each seeing the one before;
- a close that waits for the turn in flight;
- a corrupted checkpoint refused, with its record unchanged.

### Measured on the production host

`node --expose-gc test/measure-host.mjs` measures `ArtifactHost` with the minimal agent, on Node v26.13.1, 4 vCPU Xeon
@ 2.10 GHz, under the default 256 MiB guest memory limit:

| Step                                               | Time or memory                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Load the artifact (`loadArtifact`)                 | 35 ms                                                                                                |
| Open the host; it warms one guest as `verify` does | 7.8 s                                                                                                |
| New session: start its instance                    | 7.7 s                                                                                                |
| New session: eve's start in it (no session yet)    | 4 ms                                                                                                 |
| New session: whole delivery                        | 8.2 s                                                                                                |
| Warm delivery                                      | 346 ms                                                                                               |
| Two new sessions and one warm, at once             | 8.3 s wall (7.8 s, 8.3 s, 382 ms each)                                                               |
| Restore a 4-turn session on a new instance         | instance 7.7 s, then restore 27 ms                                                                   |
| Restore a 20-turn session on a new instance        | instance 7.5 s, then restore 156 ms                                                                  |
| Guest memory per instance                          | 209.6 MB (limit 256 MiB, no memory faults)                                                           |
| Process memory (RSS)                               | 683 MB after open; 901 MB with one session; 1,129 MB with three instances; 586 MB after idle release |

Every new session, and every session after its idle window, pays the instance start. Restoring the session itself
takes tens to hundreds of milliseconds.

On the same machine, `experiments/eve-host-boa/host/measure-cold.mjs` loads the S5 program in 7.6-8.4 s and this
program in 7.4-8.0 s (209.6 MB). That is within S5's 15 s budget and the host's 30 s `maxInitMs`. On Node v22 both
take about 14 s.

## Applications and acting identity

Several applications connect to the one organizational eve through AppBoundry's connections@1. An application
contributes conversations and capabilities; it does not own eve, its identity, its sessions or its authority.

- **A connection** is a durable host record an operator creates: the application, the host principal it calls as,
  the capabilities it contributes, and the keys that sign its person assertions (`appboundry admin connections add`).
  It is `active`, `disconnected` or `revoked`; revoked is final. Connecting grants no authority by itself.
- **Each delivery** is checked by the host before the guest runs: the caller must match an active connection, the
  lane must be that application's, and `assertion` (an ES256 JWT, `iss` the application's issuer, `aud` the agent,
  short-lived, each `jti` used once) must verify. The guest sees the connection and the verified person, never the
  assertion.
- **Each capability call** must be one the caller's connection contributes, and AuthBoundry must allow it for that
  person (`POST /_authboundry/authorize/check`, `on_behalf_of`), at the time of the call. A refusal reaches the model
  as the call's error; nothing reaches the provider. The ledger records the connection, the person, and
  AuthBoundry's `decisionId` and `delegationId`; the provider receives the person and the delegation as AppPort's
  invocation context.
- **The deployment binds AuthBoundry**: `appboundry run --authority authority.json`, with the credentials read from
  environment variables. Without a binding every person-acting call is refused.

`test/connections.test.mjs` runs `meetings` (contributing `repo.changes.get`) and `review` (`repo.changes.publish`)
against one host process and one AuthBoundry, and checks:

| #    | Requirement                                                       | Evidence                                                                                                                       |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1-4  | two applications, one eve, distinct applications and callers      | both connections active; the ledger shows `org-eve` acting for alice (meetings) and bob (review)                               |
| 5    | one application cannot act as another                             | another lane: `SESSION_OUTSIDE_CONNECTION`; another's signature: `UNAUTHORIZED`; an `application` argument: `INVALID_ARGUMENT` |
| 6-7  | disconnect one, the other works; reconnect keeps eve and sessions | `CONNECTION_DISCONNECTED`, review continues, meetings returns to the same session                                              |
| 8    | context isolation                                                 | the same conversation name under each application is two sessions; no text crosses                                             |
| 9-11 | authority from AuthBoundry, unauthorized and revoked refused      | `DELEGATION_DENIED` (`delegation_missing`, `delegation_revoked`); another application's capability: `CAPABILITY_NOT_CONNECTED` |
| 12   | evidence                                                          | connection, person, issuer and decision on every record; no assertion or credential                                            |
| 13   | idle release and restore                                          | the restored instance keeps the connection rules                                                                               |
| 14   | `SIGKILL` and restart                                             | connection states, the revocation and the sessions survive                                                                     |
| 15   | uncertain outcomes                                                | reported as "may or may not have taken effect", sent to the provider once                                                      |

Not covered: eve's HTTP channels (`sessionAccess`) are not on this path; the applications' own signing (S9) is
simulated by the test with the same key format; AuthBoundry is a local instance, not a deployed one.

## What remains after S8

- **The FeltKit organizational client (S9)**: applications signing person assertions with their own keys (a JWKS by
  `kid`) and delivering through `eve:deliver`.
- **Key rotation and discovery**: connection keys are PEM public keys set by the operator; there is no JWKS fetch.
- **Per-connection model policy**: one model binding serves every connection.
- **A published AppBoundry** serving `agents@1`, `sessions@1`, `model@1`, `capabilities@1` and `connections@1`, so eve's CI can
  verify and run the artifact.
- **A supported compile entry in eve.** The producer imports `dist/src/compiler/compile-agent.js`, which `eve` does not
  export.
- **The cold start per session lane** (about 8 s on Node 26): every new conversation, and every conversation after
  its idle window, waits for it. The host also warms one instance when it opens (7.8 s), and the first lane still
  starts its own (7.7 s).
- **The tools above** that need a sandbox, provider tools, durable child sessions or the Workflow runtime.

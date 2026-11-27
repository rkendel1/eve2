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

The same inputs give the same bytes. The program names no build-machine path: the app root becomes
`/appboundry/agent`.

## The manifest

| Field                | Value                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `application`        | from `appboundry.json`                                                                                                                      |
| `producer`           | `eve-appboundry` and the eve version                                                                                                        |
| `functions`          | `eve:deliver { session, application, conversation, message }` and `eve:answer { …, answers }`: actions with `agent: { session: "session" }` |
| `runtime.interfaces` | `actions@1`, `agents@1`, `identity@1`, `model@1`, `sessions@1`; `capabilities@1` when `requires` is not empty                               |
| `requires`           | from `appboundry.json`                                                                                                                      |
| `identity.roles`     | `member: ["eve.deliver"]`; both functions need `eve.deliver`                                                                                |
| `permissions`        | no collections, services, network or filesystem                                                                                             |
| `omitted`            | what the agent configures that the artifact does not carry: the model (a reference; the deployment binds it), the sandbox, eve's channels   |

A delivery's `session` must be `<application>.<conversation>`, so agents@1 serializes each conversation on its own
lane. The guest refuses any other value. eve's `auth` is the principal the host authenticated, never an argument.

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

Each tool is then checked on its own module closure. A tool whose code needs a Node built-in the guest lacks could be
called by the model but could not run, so the build is refused. The error names the tool, the built-ins and the
modules that import them, and says how to remove the tool. eve's turn path, the entry's static graph short of the
tools, may import no such built-in either.

| Fixture                          | Tools                                                 | Result                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/minimal-agent`         | two capability tools (one needs approval), a subagent | built; keeps the 5 base and agent modules; stubs 24, including `tools/provided/*`                                                                    |
| `fixtures/framework-tools-agent` | `ask_question`, `no_reply`, a capability tool         | built; the same keep list; the tools are statically imported                                                                                         |
| `fixtures/default-tools-agent`   | eve's defaults                                        | keeps 11 (adds `tools/provided/{bash,read-file,write-file,edit-file,web-fetch}.js` and `tools/framework/agent.js`), then refused: `TOOL_UNAVAILABLE` |
| `fixtures/declared-tools-agent`  | `bash`, `read_file`, `web_fetch` declared             | refused: `bash` needs `node:crypto`, `read_file` `node:crypto` and `node:path`, `web_fetch` `node:dns`                                               |

eve's `bash`, file and web tools also need a sandbox and network, which AppBoundry does not offer, so they cannot run
there with or without the built-ins. `sleep` is refused as well: it pulls in the Workflow runtime's Node chunks.

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

- `test/producer.test.mjs` (needs the engine) covers:
  - the section format, the declaration and the keep derivation;
  - the manifest; no Node built-in on the turn path; no credential or build-machine path;
  - the refusals; byte-identical rebuilds.
- `test/appboundry.test.mjs` (needs the engine and the checkout) covers:
  - AppBoundry's `parseManifest`, `artifact verify` and `artifact inspect`;
  - refusal of `agents@2`, of a missing `agents@1` or `actions@1`, and of functions that differ from the program.
- `test/host.test.mjs` (needs the engine and the checkout) runs the artifact on AppBoundry's `ArtifactHost`, with a
  scripted model and a real AppPort provider:
  - deliveries with history, and a capability call;
  - approval, then exactly one call; an uncertain outcome;
  - restore by a new host over the same state;
  - refusal of a mismatched session and of an unpermitted caller.

Without those variables the suites that need them are skipped, naming the variable. eve's CI does not set them yet.

## What S6 shows, and what S7 still needs

S6 shows that:

- the organization's eve is produced, reproducibly, from its compiled agent into an artifact AppBoundry verifies;
- the artifact runs its deliveries on AppBoundry's production host with the host's model, sessions, capabilities and
  approvals.

S7 still needs:

- **Scoped restore.** eve's `restore()` restores every stored session. With one instance per session, each new
  instance restores all of them.
- **Cold start per session lane.** Every new session lane is a cold start: the program loads in about 14 s on Node v22 here, and S5 measured 7.8-8.6 s on Node v26. Memory is 209.5 MB, under the host's 256 MiB.
- **A published AppBoundry** serving `agents@1`, `sessions@1` and `model@1`, so eve's CI can verify and run the
  artifact.
- **A supported compile entry in eve.** The producer imports `dist/src/compiler/compile-agent.js`, which `eve` does not
  export.
- **The final scenario**, steps 1-3 and 11-14, against the artifact.

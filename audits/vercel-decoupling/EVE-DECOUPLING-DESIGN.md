# eve decoupling design

## Finding that shapes the design

The four target layers already exist in eve 1.0.2:

| Layer                | Already present                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Core              | Harness, sessions, channels, tools, and workflows run on the Workflow SDK `World` contract and Nitro, with no Vercel import on the plain-host path.                                                                                                                               |
| B. Neutral contracts | Workflow `World` (local, Postgres, Vercel, any package); the sandbox provider contract (Docker, just-bash, Vercel, custom); AI SDK `LanguageModel` (any provider); `AuthFn` (OIDC, JWT, Basic, custom); the `fileMemory` backend; the dynamic-schedule `provider`; OpenTelemetry. |
| C. Adapters          | Local and Postgres worlds, the Docker sandbox, direct OpenAI/Anthropic helpers, the Nitro `node-server` preset, and an in-process schedule runner.                                                                                                                                |
| D. Optional Vercel   | `world-vercel`, Vercel Sandbox, the `vercel` preset, Agent Runs, Blob, Vercel Schedules, `vercelOidc`, `eve link`/`eve deploy`.                                                                                                                                                   |

So no new abstraction is justified. Adding a "deployment provider" or "model routing" interface on top of these contracts would duplicate existing ones. The work is to fix the defaults that leak Vercel into the non-Vercel path, and to prove that path end to end.

## Decisions

### D1. Fix `eve init --model openai-api/<id>` / `anthropic-api/<id>` (implemented)

**Problem.** The CLI documents and validates these slugs as direct-provider selections. `/login` renders them correctly. But the init template special-cased only `chatgpt/`, so init wrote `model: "openai-api/gpt-6-luna-fast"`. At runtime that string goes to AI Gateway as an invalid ID. A user who chose a direct provider was silently routed to Vercel.

**Change.** `setup/scaffold/create/project.ts` now uses the shared `parseModelHelper` (already the source of truth for `/login` and `eve set model`) instead of the ChatGPT-only parser. It renders `import { <helper> } from "<module>"` and `model: <helper>("<id>")`. This adds no new contract and has the same parse semantics as before for `chatgpt/`.

### D2. CLI telemetry is opt-in and honors `DO_NOT_TRACK` (implemented)

**Problem.** Every CLI invocation sent usage events to `telemetry.vercel.com` unless the user had opted out. The notice printed only on a TTY, so CI and coding-agent runs sent data without ever being told. This conflicts with "avoid transmitting data to Vercel without explicit configuration."

**Change.**

- `cli/telemetry/preference.ts` defaults `enabled` to `false` when no preference is saved.
- `cli/telemetry/index.ts` treats any non-empty `DO_NOT_TRACK` other than `0` as disabled, both for sending and for the notice.
- An explicit `eve telemetry enable` persists `enabled: true` and keeps working.

**Compatibility.** Machines that never chose a setting stop sending. Nobody who explicitly opted in loses telemetry. Shipped as a `minor` changeset because it changes documented default behavior.

### D3. No change: model string routing

Strings resolving to AI Gateway is AI SDK semantics (`gateway` is the SDK's global default provider). eve already honors the SDK's override (`globalThis.AI_SDK_DEFAULT_PROVIDER`) on every resolve path. Guessing a direct provider from the slug and whichever env keys exist would be hidden runtime inference. It would also be lossy, because gateway slugs are not native provider IDs (`anthropic/claude-sonnet-5` vs `claude-sonnet-5`). The explicit, inspectable path is a model instance in `agent.ts`, and D1 makes `eve init` produce one.

### D4. No change: build target and world selection by `VERCEL`

Absence of `VERCEL` already yields the neutral path (`.output/`, local world). `experimental.workflow.world` gives explicit control. Adding a `--target` flag would be new public CLI surface with no observed defect behind it. It is listed as optional follow-up.

### D5. Deferred: genuine gaps that need new adapters or public API

These are recorded in `EVE-REMAINING-GAPS.md`:

- Multi-agent workspace builds produce Vercel output only.
- `fileMemory()` has no self-hosted default backend.
- Dynamic schedules have no self-hosted provider.

Each needs a research doc per the repository's public-API rules, so none were rushed in here.

## Out of scope by instruction

- Removing any Vercel integration.
- An AppBoundry adapter. It should be one more implementation of the existing contracts in section B, built once the neutral path is proven, which this change does.

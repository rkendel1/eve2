# eve Vercel dependency audit

Scope: `packages/eve` source (runtime, compiler, CLI, scaffolding), docs, and templates at base commit `90c9e7f`. All paths are under `packages/eve/src/` unless stated. Findings come from source reading and code search. The runtime behavior of the rows marked **verified** was exercised directly (see `EVE-DECOUPLING-RESULTS.md`).

Classification:

- **Mandatory**: fails without Vercel.
- **Default**: Vercel unless the user opts out.
- **Optional**: used only when Vercel is selected or detected.
- **Docs-only**: copy, with no behavior.

Priority:

- **P0**: blocks or misroutes a non-Vercel user on a documented path.
- **P1**: a Vercel default with a working alternative.
- **P2**: optional or cosmetic.

## Summary

eve 1.0.2 is substantially infrastructure-neutral at runtime. On a plain Node host (`eve build` + `eve start`, no `VERCEL*` variables, no gateway key), the following hold:

- Durable execution uses the local Workflow world (SQLite).
- Static schedules run in-process.
- Agent Runs telemetry is not seeded.
- `@vercel/connect` and Blob are not touched.
- Models can be called directly through `eve/models/*` or any AI SDK provider.

The remaining coupling is concentrated in **defaults**: model string routing, scaffolding, CLI telemetry, default route auth, sandbox selection, and two experimental features. There is also one **mandatory** path: multi-agent workspace builds.

## Inventory

### Models and credentials

| Location                                                                                  | Dependency                                                                                                                          | Class              | Impact without Vercel                                                                                     | Replacement                                                                          | Pri    | Evidence                                                                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------- |
| `harness/model-call/model.ts:32`, `unique-call-ids.ts:12-15`, `ai/decision-adapter.ts:18` | Every string model ID resolves through AI SDK `gateway` (`ai-gateway.vercel.sh`) unless `globalThis.AI_SDK_DEFAULT_PROVIDER` is set | Default            | String models fail auth without `AI_GATEWAY_API_KEY`/OIDC                                                 | Model instance: `openai()`/`anthropic()` from `eve/models/*`, or any AI SDK provider | P1     | verified: direct `anthropic()` turn succeeds with no gateway credential |
| `shared/default-agent-model.ts:3-4`, `setup/scaffold/create/project.ts`                   | Scaffolded and implicit default model `openai/gpt-6-luna-fast` is a gateway string                                                  | Default            | New project cannot call a model with only a provider key                                                  | `eve init --model openai-api/<id>` (fixed in this change) or `/login` onboarding     | P1     | code                                                                    |
| `setup/scaffold/create/project.ts:84-108` (before fix)                                    | `eve init --model openai-api/…` / `anthropic-api/…` wrote the slug as a gateway string                                              | **Bug**            | The direct-provider path silently routed to AI Gateway with an invalid ID                                 | Fixed: renders the helper import                                                     | **P0** | verified: reproduced, then fixed                                        |
| `internal/model-auth/gateway-credential.ts:30-59`                                         | Gateway credential order: Vercel OAuth/CLI token → `AI_GATEWAY_API_KEY` → `VERCEL_OIDC_TOKEN`                                       | Optional           | Only used for gateway routing                                                                             | n/a                                                                                  | P2     | code                                                                    |
| `setup/flows/model-login.ts:37-44,266-275`, `model-login-options.ts`                      | Onboarding lists Vercel first; final fallback connection is `vercel-cli`                                                            | Default            | Interactive only; direct keys are detected first when present in env                                      | Pick OpenAI/Anthropic key                                                            | P2     | code                                                                    |
| `compiler/model-catalog.ts`, `internal/gateway.ts:3-7`                                    | Build fetches model metadata from `ai-gateway.vercel.sh/v1/models/catalog`                                                          | Default (degrades) | Offline: build warns `compile/model-metadata-unavailable`; dynamic models need `modelContextWindowTokens` | Set `modelContextWindowTokens`                                                       | P1     | code (`compiler/artifacts.ts:232-240`)                                  |
| `internal/nitro/routes/info.ts:66-78`                                                     | `/info` probes Vercel OIDC for gateway routing                                                                                      | Optional           | try/catch; reports `oidc:false`                                                                           | n/a                                                                                  | P2     | code                                                                    |

### Build and deployment

| Location                                                                                  | Dependency                                                                                                       | Class                          | Impact                                                                                        | Replacement                  | Pri | Evidence                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------- | --- | ----------------------------------- |
| `internal/nitro/host/build-application.ts:279,307`, `internal/application/paths.ts:33-35` | Target chosen solely by `VERCEL` env var                                                                         | Optional                       | None: absent → Node `.output/`                                                                | n/a                          | —   | verified both targets               |
| `internal/vercel/build-agent-workspace.ts:43,49`                                          | Multi-agent workspace (`agents/`) builds always write `.vercel/output` with Vercel services config               | **Mandatory**                  | Workspaces cannot produce a self-hosted Node server                                           | None today                   | P1  | code (not executed)                 |
| `cli/commands/deploy.ts`, `setup/flows/deploy.ts`, `setup/boxes/deploy-project.ts`        | `eve deploy` runs `vercel link`/`vercel deploy --prod`/`vercel env pull`; offers to install Vercel CLI           | Optional (Vercel-only command) | The command is Vercel-only. Self-hosted deploy is `eve build` + ship `.output/` + `eve start` | Documented self-hosting path | P2  | code                                |
| `cli/commands/link.ts`, `vercel-non-interactive.ts`                                       | `eve link` = `vercel link` + `vercel env pull`                                                                   | Optional                       | Vercel-only                                                                                   | n/a                          | P2  | code                                |
| `setup/scaffold/create/project.ts:164,170-179,253-260`                                    | Scaffold adds `"deploy": "eve deploy"`, `@vercel/connect` dependency, `.vercelignore`, README "Deploy on Vercel" | Default                        | Unused files/deps; no failure                                                                 | Ignore or delete             | P2  | verified (generated `package.json`) |
| `setup/scaffold/update/channels.ts:464-473`                                               | Adding the web channel writes `vercel.json`                                                                      | Default                        | Inert off-Vercel                                                                              | n/a                          | P2  | code                                |
| `internal/nitro/host/vercel-build-prewarm.ts`                                             | Sandbox prewarm requires OIDC                                                                                    | Optional (`VERCEL` only)       | n/a                                                                                           | `--skip-sandbox-prewarm`     | P2  | code                                |

### Execution, sandbox, workflow, storage, schedules

| Location                                                                                       | Dependency                                                                                           | Class                   | Impact                                                                    | Replacement                                   | Pri | Evidence                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- | --------------------------------------------- | --- | ---------------------------------------------------- |
| `internal/nitro/host/prepare-application-host.ts:155-161`, `internal/workflow/world-target.ts` | World: `vercel` iff `VERCEL`, else `local`                                                           | Optional                | None                                                                      | `experimental.workflow.world` (e.g. Postgres) | —   | verified: restart resumes session on local world     |
| `sandbox/providers/default.ts:202-206`                                                         | `DefaultSandbox`: Vercel iff `VERCEL`, else Docker if reachable at build, else none in production    | Default                 | Without Docker at build time, sandbox tools fail with an actionable error | Docker, just-bash, custom provider            | P1  | verified: error text captured, Docker path exercised |
| `execution/sandbox/bindings/eve-image.ts:6`                                                    | Default Docker image `ghcr.io/vercel/eve:<tag>`                                                      | Optional (public image) | Needs registry access, not a Vercel account                               | `docker: { image }`                           | P2  | verified: anonymous pull                             |
| `public/memory/file/backends/default.ts:31-43`                                                 | `fileMemory()` default backend: Blob on Vercel, in-memory in dev, **throws** elsewhere               | Default                 | Must pass `fileMemory({ backend })` self-hosted                           | Explicit backend                              | P1  | code                                                 |
| `public/schedules/subscription.ts:505`, `providers/vercel.ts:236-241`                          | Experimental dynamic schedules default to `vercelScheduleProvider()`; throws off-Vercel on first use | Default (experimental)  | No self-hosted dynamic schedules out of the box                           | Custom `provider`                             | P1  | code                                                 |
| `public/definitions/workspace-agent.ts:75-101`                                                 | Default workspace-agent transport requires Vercel workspace env                                      | Default                 | Throws unless a transport is passed                                       | Explicit transport                            | P2  | code                                                 |
| `self-modification/deployed-sandbox.ts:21,33`                                                  | Deployed self-modification is Vercel-only                                                            | Mandatory (feature)     | Feature unavailable self-hosted                                           | None                                          | P2  | code                                                 |
| `extensions/custom-skills/extension/lib/runtime.ts:18-23`                                      | Blob storage only when Blob env set                                                                  | Optional                | Storage `null` otherwise                                                  | n/a                                           | P2  | code                                                 |

### Auth, identity, connections

| Location                                                                                                     | Dependency                                                        | Class    | Impact                                                                             | Replacement                                        | Pri | Evidence                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | --- | ----------------------------------------------- |
| Default channel policy (`docs/channels/eve.mdx` §Authentication; `setup/scaffold/create/web-template.ts:74`) | `[vercelOidc(), localDev(), placeholderAuth()]`                   | Default  | Production self-host rejects all callers until auth is configured (secure default) | `jwtHmac`, `jwtEcdsa`, `oidc`, `httpBasic`, custom | P1  | verified: 401 unauthenticated; `jwtHmac` admits |
| `runtime/resolve-connection.ts:134-144` etc.                                                                 | `@vercel/connect` marker                                          | Optional | Only behind `vercelConnect !== undefined`                                          | `getToken`/bearer connections                      | —   | code                                            |
| `cli/dev/tui/remote-auth.ts`, `setup/verified-remote-agent.ts`                                               | `eve remote connect` falls back to Vercel SSO only on 3xx/401/403 | Optional | Works against any URL with `-H`                                                    | n/a                                                | P2  | code                                            |

### Telemetry and observability

| Location                                            | Dependency                                                                                                                       | Class    | Impact                                             | Replacement                        | Pri                  | Evidence              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- | ---------------------------------- | -------------------- | --------------------- |
| `cli/telemetry/flush.ts:1`, `preference.ts`         | CLI usage events POSTed to `telemetry.vercel.com` **by default**; first-run notice only on a TTY, so CI/agent runs sent silently | Default  | Data sent to Vercel without explicit configuration | Fixed: opt-in, plus `DO_NOT_TRACK` | **P0** (per mission) | unit tests            |
| `instrumentation/providers.ts:47-49`                | Agent Runs seeded only when `VERCEL_ENV` is preview/production                                                                   | Optional | None                                               | OpenTelemetry                      | —                    | code + existing tests |
| `tracing/eve/vercel-runtime-span-exporter.ts:21-35` | Reports spans only through in-process Vercel request context                                                                     | Optional | No network path off-Vercel                         | —                                  | —                    | code + existing test  |

### Templates, examples, docs

| Location                                                                                                                                   | Dependency                                                   | Class     | Pri |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------- | --- |
| Root `package.json` description "durable backend agents on Vercel"                                                                         | Copy                                                         | Docs-only | P2  |
| `apps/templates/*`: 8 of 25 have `vercel.json`/`vercel.ts`; 6 `.env.example` files mention `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN`        | Gallery templates (not used by `eve init`)                   | Default   | P2  |
| Scaffolded `AGENTS.md`/instructions ("Vercel's agent framework", "Use eve for Vercel operations"), `vercel-connect.md` coding-agent prompt | Copy                                                         | Docs-only | P2  |
| `docs/guides/deployment/*`, `docs/sandbox/*`                                                                                               | Already document self-hosting, worlds, Docker, direct models | —         | —   |

## Dependency graph (default paths)

```
eve init ──► agent.ts model: "openai/…" (string) ──► AI SDK gateway ──► ai-gateway.vercel.sh   [default]
         └─► --model openai-api/… ──► openai() helper ──► api.openai.com                         [fixed]
eve build ─┬─ VERCEL? ──yes──► .vercel/output + world-vercel + Vercel Sandbox                    [optional]
           │           └─no──► .output/ + world-local + Docker|none                              [neutral]
           ├─ model catalog ──► ai-gateway.vercel.sh (warn on failure)                           [degrades]
           └─ agents/ workspace ──► .vercel/output only                                          [mandatory]
eve <any cmd> ──► CLI telemetry ──► telemetry.vercel.com                                         [was default; now opt-in]
eve start ──► local world (SQLite) · Nitro schedules · OTel if declared · auth list              [neutral]
```

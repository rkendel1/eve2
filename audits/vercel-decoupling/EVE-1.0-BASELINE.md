# eve 1.0 baseline

Recorded 2026-11-17 before any change in this audit.

## Repository identity

| Field            | Value                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Repository       | `rkendel1/eve2` (fork of `vercel/eve`)                                                                                 |
| Branch           | `claude/dreamy-galileo-4z03p5`                                                                                         |
| Base commit      | `90c9e7f1e210ea77090c5426510616fd66b289d8` (`feat(eve): stop a session's sandbox after the session goes idle (#6560)`) |
| `eve` version    | `1.0.2` (`packages/eve/package.json`)                                                                                  |
| Package manager  | pnpm `12.21.0` workspace, turbo task runner                                                                            |
| Node requirement | `>=24` (`packages/eve/package.json` `engines`)                                                                         |
| Tracked files    | 8,588                                                                                                                  |

## Workspace structure

- `packages/eve`: the framework and `eve` CLI. Runtime `dependencies` are only `nitro`, `rolldown`, `undici`. Every `@vercel/*` and `@workflow/*` package is a devDependency vendored into `#compiled/*` at build time.
- `packages/eve-*`, `packages/tracing`: internal or extension packages.
- `apps/fixtures`, `apps/templates`, `apps/frameworks`, `apps/docs`: fixtures, gallery templates, framework smoke apps, docs site.
- `docs/`: published documentation; `examples/`, `e2e/`, `research/`.

## Architecture boundaries relevant to Vercel

| Concern           | Mechanism in eve 1.0.2                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build target      | Nitro. `VERCEL` set → `vercel` preset, `.vercel/output`; otherwise `node-server` preset, `.output/`.                                                                                                                                      |
| Durable execution | Workflow SDK. World chosen at build: `VERCEL` → `@workflow/world-vercel`; otherwise `@workflow/world-local` (SQLite in `.eve/.workflow-data`). `experimental.workflow.world` selects any world package (e.g. `@workflow/world-postgres`). |
| Sandbox           | `DefaultSandbox` picks at build: Vercel Sandbox if `VERCEL`, else Docker if a Linux daemon answers, else just-bash in dev, else none. Explicit providers: Vercel, Docker, just-bash, custom.                                              |
| Models            | String IDs → AI SDK `gateway` (Vercel AI Gateway). Model instances (`eve/models/openai`, `eve/models/anthropic`, any AI SDK provider) call providers directly.                                                                            |
| Schedules         | Static schedules → Nitro scheduled tasks in `eve start`. Experimental dynamic schedules default to a Vercel provider.                                                                                                                     |
| Observability     | Agent Runs seeded only when `VERCEL_ENV` is preview/production; OpenTelemetry registered only when declared.                                                                                                                              |
| Route auth        | Ordered `AuthFn` list; built-ins include `vercelOidc`, `oidc`, `jwtHmac`, `jwtEcdsa`, `httpBasic`, `localDev`.                                                                                                                            |

## Initial health (unmodified tree)

| Check                            | Result                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Pass                                                                                                                                                                                                 |
| Build `eve` (turbo)              | Pass. `pnpm build:eve` fails in this container with `Exec format error` when turbo is launched through the pnpm shim; `npx turbo run build --filter=eve` passes. Container quirk, not a repo defect. |
| Typecheck `eve`                  | Pass                                                                                                                                                                                                 |
| Unit tests, Node 22.23.5         | 36 failures in 2 files (`test/bin-bootstrap.test.ts`, `start-development-server.test.ts`): `eve requires Node.js >=24`. Environmental.                                                               |
| Unit tests, Node 24.22.3         | 937 files, 9,311 passed, 1 expected fail, 1 skipped, 0 failed                                                                                                                                        |
| Integration / scenario / e2e     | Not run in full (repo guidance: CI owns full tiers; e2e is CI-only). Targeted runs recorded in the results file.                                                                                     |

## Environment available for verification

- No Vercel CLI on `PATH`; no `.vercel/` link.
- `AI_GATEWAY_API_KEY` (free-tier Vercel account), an Anthropic API key (`BENCH_API_KEY`), `OPENAI_API_KEY`.
- Docker CLI present; daemon not running initially, started manually with `dockerd` for sandbox verification.

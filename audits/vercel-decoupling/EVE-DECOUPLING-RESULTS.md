# eve decoupling results

## Changes

| File                                                                                             | Change                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/eve/src/setup/scaffold/create/project.ts`                                              | Init renders `openai-api/…`, `anthropic-api/…` (and `chatgpt/…`) as eve model helpers via the shared `parseModelHelper` |
| `packages/eve/src/setup/scaffold/create/project.test.ts`                                         | +3 tests: both direct helpers, and a gateway string stays a string                                                      |
| `packages/eve/src/cli/telemetry/preference.ts`                                                   | Default `enabled: false`                                                                                                |
| `packages/eve/src/cli/telemetry/index.ts`                                                        | `DO_NOT_TRACK` disables sending and the notice                                                                          |
| `packages/eve/src/cli/telemetry/preference.test.ts`, `index.test.ts`                             | Default-off, persisted opt-in, `DO_NOT_TRACK=1`/`true`                                                                  |
| `docs/reference/telemetry.md`, `docs/reference/cli/index.md`                                     | Opt-in wording; `DO_NOT_TRACK`; init `--model` direct slugs                                                             |
| `.changeset/cli-telemetry-opt-in.md` (minor), `.changeset/init-direct-provider-model.md` (patch) | Release notes                                                                                                           |

Custom code: about 20 lines of production code changed across 3 files. Everything else on the non-Vercel path is existing eve code, which was reused and verified, not rewritten.

## Verification

### Automated (repository gates)

| Check                                                      | Result                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| Unit tests, Node 24                                        | 937 files, **9,317 passed** (baseline 9,311 + 6 new), 0 failed |
| `src/setup/flows/login-first-response.integration.test.ts` | 1/1 passed                                                     |
| `src/setup/flows/model-source-change.scenario.test.ts`     | 5/5 passed                                                     |
| Typecheck (`eve`)                                          | Pass                                                           |
| `pnpm guard:invariants`, `guard:docs-budget`, `docs:check` | Pass                                                           |
| oxlint / oxfmt                                             | No new findings; pre-existing warnings in untouched files      |

These are unit tests with mocked filesystem/spawn. They prove the logic, not the infrastructure. The infrastructure evidence is below.

### Real execution (no mocks)

**Setup.**

- Packed the locally built `eve` (`pnpm pack`) and scaffolded a new project with the fixed CLI: `eve init agent1 --model anthropic-api/claude-sonnet-5 -n`.
- Every command ran under `env -i` with only `PATH`, `HOME`, the proxy CA, and the variables listed per row. There were no `VERCEL*` variables, no `AI_GATEWAY_API_KEY`, no Vercel CLI on `PATH`, and no `.vercel/` link.
- Route auth was replaced with `jwtHmac()` (HS256), a provider-neutral production policy.

| #   | Claim                                                   | Evidence                                                                                                                                                                                                                                                                                                                            | Status                                                                                                 |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Installs without Vercel credentials                     | `pnpm install` of the scaffold succeeded; no credentials present                                                                                                                                                                                                                                                                    | Verified                                                                                               |
| 2   | Starts without Vercel env                               | `eve start` → `GET /eve/v1/health` `{"ok":true,"status":"ready"}`                                                                                                                                                                                                                                                                   | Verified                                                                                               |
| 3   | Direct model provider works                             | Generated `agent.ts` = `anthropic("claude-sonnet-5")`. Turn completed with reply `stored.` and `usage.recorded` 6,374 in / 5 out. Only `ANTHROPIC_API_KEY` in the environment                                                                                                                                                       | Verified                                                                                               |
| 4   | Builds without Vercel CLI                               | `eve build` wrote `.output/` and no `.vercel/`                                                                                                                                                                                                                                                                                      | Verified                                                                                               |
| 5   | Non-Vercel execution backend                            | Docker daemon running at build. `DefaultSandbox` built template image `eve-sandbox-template:…` from `ghcr.io/vercel/eve` (anonymous pull). A turn issued a `bash` call (`call.requested/started/settled`) and the reply was `Linux` / `selfhost-ok`. `proof.txt` was read back from inside the session container with `docker exec` | Verified                                                                                               |
| 6   | Persist and recover state                               | Killed the server, confirmed it was down, then restarted. A follow-up to the same `sessionId` asked for the codeword and the model answered `PELICAN-42` from history stored in `.eve/.workflow-data/world.db` (local world, SQLite)                                                                                                | Verified                                                                                               |
| 7   | Workflow path without Vercel                            | Items 3, 5 and 6 ran on `@workflow/world-local`. Postgres world not exercised                                                                                                                                                                                                                                                       | Verified (local world)                                                                                 |
| 8   | Non-Vercel deploy path                                  | `eve build` → `.output/` → `eve start` on Node 24, served over HTTP with JWT auth. No container image or remote host was produced                                                                                                                                                                                                   | Verified locally; not deployed to a remote host                                                        |
| 9   | Vercel still works when selected                        | (a) AI Gateway: same build style with only `AI_GATEWAY_API_KEY` and model string `google/gemini-2.5-flash-lite`; the turn completed with gateway-reported `costUsd` 0.0001591. (b) `VERCEL=1 eve build` wrote `.vercel/output` (`functions/`, `config.json`), and the workflow function bundles `world-vercel`                      | Gateway verified. Vercel build output verified. **Actual Vercel deployment not verified** (no account) |
| 10  | Missing Vercel integrations cause no unrelated failures | Items 1–8 had no Vercel-related errors. Unauthenticated requests got 401 from `jwtHmac`                                                                                                                                                                                                                                             | Verified                                                                                               |

### Observations made during verification

- `anthropic/claude-sonnet-5` through the gateway failed with "Free tier users do not have access to this model". eve surfaced the error correctly with a semantic hint. This is a property of the test account, not a defect.
- With no Docker daemon at build time, a self-hosted production build has no sandbox. The first tool call fails with `DefaultSandbox has no sandbox provider for this build: … Start Docker and rebuild, deploy to Vercel, or select a provider explicitly…`. This is documented behavior and the error is actionable.
- `pnpm build:eve` hits `Exec format error` in this container while `npx turbo` works. This is environmental.

## Before vs after

| Area                                                             | Before                                                     | After                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Init with a direct provider                                      | Wrote a gateway string, so calls went to Vercel and failed | Writes `anthropic()`/`openai()`, so calls go directly to the provider |
| CLI telemetry                                                    | On by default to Vercel, silent off-TTY                    | Off unless `eve telemetry enable`; `DO_NOT_TRACK` honored             |
| Self-hosted build, run, durability, Docker sandbox, direct model | Already supported, undocumented as verified                | Verified end to end                                                   |

# Self-hosted parity: baseline

Recorded 2026-11-17 at the start of this slice. This builds on `audits/vercel-decoupling/` and re-verifies only what this slice depends on.

## Repository state

| Field                    | Value                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                   | `claude/dreamy-galileo-4z03p5`, clean, equal to `origin/claude/dreamy-galileo-4z03p5`                                                         |
| HEAD                     | `1eb96d5` (`fix: keep eve init direct-provider models and CLI telemetry off Vercel by default`), the previous slice                           |
| Upstream drift           | `origin/main` has no commits beyond HEAD's base (`90c9e7f`)                                                                                   |
| `eve` version            | `1.0.2`                                                                                                                                       |
| Node                     | `engines.node` `>=24`. CI pins `.nvmrc` = **26.13.1**. This slice installed Node 26.13.1 locally to match CI; the previous slice used 24.22.3 |
| Previous slice's changes | Present: init renders `openai-api/…`/`anthropic-api/…` as helpers; CLI telemetry is opt-in                                                    |

## CI that can carry this work

`.github/workflows/ci.yml`, job `test-scenario` (ubuntu-latest), runs `pnpm test:scenario`. It already:

- pulls the eve sandbox image (`.github/actions/sandbox-image`);
- builds and starts real apps through `test/scenarios/eve-start-harness.ts` (`startPackagedEveStart`);
- uses `materializeScenarioApp` and `buildApplication`.

`local-workflow-restart-recovery.scenario.test.ts` already proves the local world resumes a sleeping run after `eve start` is killed, using a mock model. No new CI job or service is needed.

## Findings this slice acts on (verified in code)

| Area              | Finding                                                                                                                                                                                                                                                                                     | Evidence                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Default model     | Interactive `eve init` opens provider onboarding, so the choice is explicit. Non-interactive `eve init` writes `openai/gpt-6-luna-fast` (gateway), and a non-agent run did not print the model at all                                                                                       | `cli/commands/init.ts:566-568, 686-697` (before)                                                                       |
| Sandbox           | `DefaultSandbox` records its provider at build time in `.output/.eve/compile/sandbox-prepared-artifacts.json`. Docker templates are committed to the build host's daemon; production never prepares them lazily. Health, `/info`, `eve info` and `eve start` said nothing about the sandbox | `sandbox/providers/default.ts:145-206`; `execution/sandbox/bindings/docker.ts:125-133`; `hosted-graph-plugin.ts:21-25` |
| Sandbox docs      | **Published guidance was wrong.** "Build inside a container image" told users to select `DockerSandbox.environment()` when the build has no Docker. Reproduced: that build exits 1 with "the `docker` CLI was not found"                                                                    | `docs/guides/deployment/self-hosting/index.md` (before); reproduction log in the acceptance file                       |
| Auth              | Off Vercel, `placeholderAuth()` returned `null` because it gated on `VERCEL_ENV === "production"`. Self-hosted production returned a generic `unauthorized` 401 instead of the setup guidance the docs describe                                                                             | `channel/auth/definitions.ts:720-732` (before)                                                                         |
| Memory            | `fileMemory()` throws off Vercel and off `eve dev` by documented design. No filesystem backend existed                                                                                                                                                                                      | `public/memory/file/backends/default.ts:41-43`; `docs/memory/file.md`                                                  |
| Workspaces        | A root `eve build` always writes Vercel Build Output. Members build and run individually, and the docs say so; a root build printed nothing to that effect                                                                                                                                  | `internal/vercel/build-agent-workspace.ts`; `docs/guides/deployment/self-hosted-operations.md` "Run workspace members" |
| Dynamic schedules | Experimental. Defaults to `vercelScheduleProvider()`, which throws off Vercel. The docs direct self-hosted users to implement `ScheduleProvider`                                                                                                                                            | `public/schedules/subscription.ts:500-509`; `docs/experimental/dynamic-schedules.mdx:248-271`                          |

## Initial health on Node 26.13.1

This slice did not rerun the suites on Node 26 before changing code. The last pre-change run was the previous slice's: unit tier on Node 24.22.3, 9,317 passed, 0 failed. All Node 26 results in `EVE-SELF-HOSTED-ACCEPTANCE.md` were taken after this slice's changes. Failures there are classified by reproducing them with the triggering condition removed.

Known container quirks, which are not repository defects:

- `pnpm build:eve` and `pnpm pack`'s prepack fail with `Exec format error` when turbo is spawned through the pnpm shim. `npx turbo …`, the staging scripts and `npm pack` in `.package/` work.
- The shell has `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY` and `BENCH_API_KEY` set. One integration test treats a model as connected when such a key exists.

# Vercel architectural-dependency removal: results

## Final status by original limitation

| #   | Limitation                                  | Result                                                                                                        |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Workspaces build only on Vercel             | **Removed.** Root `eve build` builds every member for Node; root `eve start` runs the workspace on one origin |
| 2   | Agent communication requires Vercel         | **Removed for `eve start` workspaces.** Signed peer tokens, `workspacePeers()`, callback allowlist            |
| 3   | No self-hosted dynamic schedules            | **Removed.** `workflowScheduleProvider()` on the Workflow world                                               |
| 4   | Deployed self-modification requires Vercel  | **Remains.** Blocker: credential brokering. The activation and rollback lifecycle exists nowhere              |
| 5   | Agent Runs tracing Vercel-specific          | **Never required.** OpenTelemetry export proven without Vercel                                                |
| 6   | Model metadata fetched from Vercel at build | **Removed.** Bundled metadata plus `EVE_MODEL_CATALOG=bundled`                                                |
| 7   | Sandbox build-time Docker                   | **Remains.** Build and runtime must share the Docker daemon; readiness is verified at start                   |

## Already supported before this slice

- Local and Postgres Workflow worlds.
- The remote-agent protocol with forwarded-principal authority.
- `jwtHmac` verification.
- The `ScheduleProvider` contract.
- The durable hook-and-sleep pattern (`connectionEventWorkflow`).
- OpenTelemetry tracing with authored exporters.
- Per-member builds and `startProductionServer`.

## Implemented

| Commit                  | Change                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4ba334a`               | Workspace host (`internal/workspace/start-workspace-host.ts`), self-hosted peer transport and `workspacePeers()`, `EVE_CALLBACK_ALLOWED_ORIGINS`, per-member env isolation in `startProductionServer`, prewarm no longer resolving remote URLs, bundled model metadata plus `EVE_MODEL_CATALOG` |
| `e56166c`               | `workflowScheduleProvider()` (`public/schedules/providers/workflow.ts`, `runtime/schedules/durable/*`), stable workflow registration, croner `nextRun` typing                                                                                                                                   |
| `de24dbf`               | Coalescing of occurrences missed during downtime, published docs, OpenTelemetry trace test                                                                                                                                                                                                      |
| `0c588fd` + this commit | Audit reports                                                                                                                                                                                                                                                                                   |

## Security and durability guarantees

- **Peer identity.** A peer caller is the service principal `eve-workspace:<agent>`.
  - Tokens are HS256, audience-bound to the callee, valid for 5 minutes, and signed with a secret of at least 32 characters.
  - User authority crosses only through the existing opt-in `forwardPrincipal` + `trustedForwarders`.
- **Callbacks.** Only exact operator- or host-configured origins bypass the loopback block. Private ranges stay blocked, and callback URLs from requests remain untrusted.
- **Member environment.** Member env files are isolated per child process.
- **Schedules.**
  - The Workflow world is the only store.
  - A schedule has one owner, enforced by its hook token.
  - Execution ids are deterministic.
  - A one-time occurrence due during downtime fires exactly once (verified).
  - Missed cron occurrences coalesce.
  - Failures retry, then fire `occurrence.failed` without stopping the schedule.
- **Unchanged.** Default auth stays secure (no open routes). No sandbox isolation was weakened.

## Size

| Category                              | Lines                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Production code (hand-written)        | +1,096 / −56. The largest files: workflow schedule provider 292, workspace host 226, schedule steps 100, peer auth 87 |
| Generated, vendored model metadata    | +3,873                                                                                                                |
| Tests                                 | +976 / −36                                                                                                            |
| Docs                                  | +102 / −34                                                                                                            |
| Config, changesets, snapshots, script | +72 / −4                                                                                                              |
| Audits                                | ~600                                                                                                                  |

## Mocked versus real

Real:

- processes, HTTP, auth, callbacks, Workflow world persistence, restarts (`SIGKILL`), wall-clock scheduling;
- Docker;
- OpenTelemetry export to a file exporter;
- offline compilation.

Mocked: model inference in every new scenario. Real Anthropic inference was verified only by the single-agent acceptance test (3/3).

## Remaining Vercel dependencies

- Deployed self-modification (Vercel Sandbox credential transforms).
- Agent Runs as a destination (optional).
- `eve deploy` and `eve link`.
- `vercelScheduleProvider()` as the `defineDynamicSchedules` default (opt-in alternative available).
- The build-time catalog request by default (falls back, or opt out with `bundled`).

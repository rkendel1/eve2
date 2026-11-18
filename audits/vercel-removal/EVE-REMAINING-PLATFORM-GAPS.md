# Remaining platform gaps after Vercel removal

## Original limitations: final status

| #   | Limitation                                     | Status                                                                                                                                                                    | Evidence or blocker                                                     |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Workspaces build only as a Vercel deployment   | **Resolved.** Root `eve build` builds every member for Node; root `eve start` runs them on one origin                                                                     | `self-hosted-workspace.scenario.test.ts`                                |
| 2   | Default peer communication requires Vercel     | **Resolved** for `eve start` workspaces: signed workspace-peer tokens, `workspacePeers()`, exact-origin callback allowlist                                                | Same scenario plus 11 unit tests                                        |
| 3   | Dynamic schedules have no self-hosted provider | **Resolved**: `workflowScheduleProvider()` on the Workflow world                                                                                                          | `self-hosted-schedules.scenario.test.ts` (downtime, restart, isolation) |
| 4   | Deployed self-modification needs Vercel        | **Not resolved.** Its only Vercel tie is credential brokering by Vercel Sandbox network transforms. The requested activation and rollback lifecycle exists on no platform | `EVE-SELF-MODIFICATION.md`: contract proposal and next step             |
| 5   | Agent Runs tracing is Vercel-specific          | **Already optional.** OpenTelemetry export works without Vercel; now proven across delegating agents                                                                      | Workspace scenario trace test                                           |
| 6   | Model metadata fetched from Vercel at build    | **Resolved**: bundled metadata fallback plus `EVE_MODEL_CATALOG=bundled`                                                                                                  | Catalog unit tests plus an offline direct-model compile scenario        |
| 7   | Sandbox depends on build-time Docker           | **Not resolved; still requires the same Docker daemon** at build and run. Requirements are still verified and reported at `eve start` (previous slice)                    | See below                                                               |

## Open technical blockers

1. **Separating the sandbox build host from the runtime host.**
   - _Blockers:_
     - The prepared-artifact manifest is inlined into the server bundle at build time.
     - Template contents come from running the author's `prepare` on the build daemon.
     - Production never prepares lazily.
   - _Missing contract:_ a deferred Docker preparation mode. In it, `eve build` records the deterministic template reference and inputs without a daemon, and a new `eve sandbox prepare` runs `prewarmAppSandboxes` against the runtime daemon from the shipped `.output/.eve/compile` and source.
   - _Next step:_ make the runtime accept a deferred entry, and add that command.
2. **Self-modification credential brokering without Vercel Sandbox.**
   - _Missing:_ an egress proxy for Docker sandboxes that injects a credential for an allowlisted host.
   - _Separately:_ the update-activation contract in `EVE-SELF-MODIFICATION.md`.
3. **Workspace member supervision.** `eve start` doesn't restart a crashed member, and a peer that dies mid-task leaves the caller waiting.
   - _Next step:_ restart members with backoff. With the local world's recovery, a restarted member resumes the in-flight run and completes the caller's task.
4. **A public callback origin inside a workspace host.** Member callback origins are loopback, so connection sign-in and external remote agents need separately run members.
   - _Next step:_ give each member `WORKFLOW_LOCAL_BASE_URL=<public>/eve/<name>`, route `/eve/<name>/.well-known/workflow/*`, and fix the double-prefix in `resolveWorkflowCallbackBaseUrl`.
5. **Remote-agent timeouts and a delegation-depth limit.** Neither exists on any platform: create and continue requests have no timeout, and dispatch has no depth cap.

## Not verified in this slice

- The Postgres world with workspaces or durable schedules, and any multi-replica behavior.
- A workspace or schedules behind a TLS reverse proxy.
- The schedule failure path (`occurrence.failed` after retries) end to end.
- An actual Vercel deployment. Vercel build outputs and Vercel-path tests pass; nothing was deployed.
- Windows and macOS.

## Remaining Vercel-only capabilities

- Deployed self-modification.
- Agent Runs.
- `eve deploy` and `eve link`.
- Vercel Sandbox network header transforms.
- `vercelScheduleProvider()`, which is still the default for `defineDynamicSchedules`; users opt into `workflowScheduleProvider()`.

# Self-hosted acceptance: Vercel architectural-dependency removal

All scenarios run in the existing CI `test-scenario` job (`pnpm test:scenario`) with:

- every `VERCEL*` variable removed;
- `PATH` limited to Node and the system directories, so no Vercel CLI;
- `EVE_MODEL_CATALOG=bundled` where the app compiles models.

**Mocked versus real:** model inference is mocked (`mockModel`) unless stated. Everything else is real:

- `eve build` / `eve start` processes and HTTP;
- route auth, callbacks, and the Workflow world (SQLite);
- Docker, and wall-clock timers.

| Requirement                                                                           | Test                                                                                                                                                | Inference                                         | Result                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| Single-agent self-hosted operation                                                    | `self-hosted-acceptance.scenario.test.ts` (previous slice)                                                                                          | Mock, plus **real Anthropic** when the key is set | 3/3, including the real-key run after this slice    |
| Multi-agent workspace build and execution                                             | `self-hosted-workspace` › builds every member…, serves every agent…                                                                                 | Mock                                              | Pass                                                |
| Agent-to-agent delegation                                                             | `self-hosted-workspace` › delegates to a peer…                                                                                                      | Mock                                              | Pass (real callback round trip)                     |
| Tenant isolation and authorization                                                    | `self-hosted-workspace` › rejects callers…; `self-hosted-schedules` › …isolates principals                                                          | Mock                                              | Pass                                                |
| Peer failure and unavailability                                                       | `self-hosted-workspace` › returns a delegated agent's failure…, reports a stopped peer…                                                             | Mock                                              | Pass                                                |
| Dynamic schedule creation and execution                                               | `self-hosted-schedules` (both tests)                                                                                                                | Mock (it drives the management tool)              | Pass                                                |
| Schedule restart and recovery                                                         | `self-hosted-schedules` › fires a one-time schedule that came due while the server was down, exactly once                                           | Mock                                              | Pass (real wall clock, real `SIGKILL`)              |
| Tracing and execution correlation                                                     | `self-hosted-workspace` › exports nested and linked traces…                                                                                         | Mock                                              | Pass                                                |
| Model metadata without Vercel                                                         | `compiler-model-catalog.scenario.test.ts` › compiles a direct Anthropic model offline…; never requests the catalog with `EVE_MODEL_CATALOG=bundled` | n/a                                               | Pass                                                |
| Sandbox readiness and execution                                                       | `self-hosted-runtime.scenario.test.ts` (previous slice)                                                                                             | Mock                                              | Pass                                                |
| Artifact generation, controlled update, approval enforcement, activation and rollback | —                                                                                                                                                   | —                                                 | **Not implemented**; see `EVE-SELF-MODIFICATION.md` |

## Gate results (Node 26.13.1, Linux, Docker 29.10.0)

| Gate                                                                                                                | Result                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unit                                                                                                                | 940 files, **9,352 passed**, 0 failed                                       |
| Integration (API keys unset)                                                                                        | 219 files, **2,675 passed**, 0 failed, 785 conditional skips (pre-existing) |
| Scenario (API keys unset)                                                                                           | 78 files, **372 passed**, 1 failed, 1 skipped                               |
| Build tier `production-build` (Nitro **and Vercel** output builds)                                                  | 20 files, **121 passed**                                                    |
| Build tier, workflow bundle builder                                                                                 | 18 passed                                                                   |
| Published declaration types                                                                                         | 26 passed                                                                   |
| Self-hosted acceptance with the **real Anthropic key**                                                              | 3/3; the key never appears in the log                                       |
| Typecheck, oxfmt, oxlint (no new findings), `guard:invariants`, `guard:docs-budget`, `docs:check`, export snapshots | Pass                                                                        |

## Failures classified

| Failure                                                                                  | Classification                                    | Evidence                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup/primitives/pm/run.scenario.test.ts` "installs standalone…"                        | Pre-existing, environmental (container pnpm)      | Fails identically on the unmodified base `1eb96d5` (previous slice)                                                                                                                                                                                              |
| `self-hosted-workspace` start failed with `#internal/application/package.js` not defined | Environmental build-state corruption              | A stray `dist/package.json` made eve's own `#imports` resolve to `dist/dist/…`. After it was removed, the identical test passed 7/7. A one-member repro with instrumentation built cleanly. The full gate run's final check confirmed the file was not recreated |
| Earlier: an `agent-info-route` 401 without a `Bearer` challenge                          | A regression from the previous slice, fixed there | The placeholder declares the challenge                                                                                                                                                                                                                           |

## Not covered

- Postgres world.
- Multiple replicas.
- TLS proxy.
- Windows and macOS.
- The schedule failure path end to end.
- A real Vercel deployment.
- Deployed self-modification.
- Separating the sandbox build host from the runtime host.

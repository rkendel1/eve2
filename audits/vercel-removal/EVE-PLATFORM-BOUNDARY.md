# Provider-neutral platform boundary

The rule applied: name the **platform responsibility** behind each Vercel dependency, reuse an existing eve contract for it, and add a self-hosted implementation only where the responsibility had none. No generic abstraction per Vercel API was added. No new database, queue, scheduler engine, or orchestration framework was introduced.

| Responsibility                | Contract (existing unless marked)                                                        | Vercel implementation                               | Self-hosted implementation                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Build a workspace             | `buildApplication(appRoot, options)` per agent                                           | Build Output API `services`; Vercel runs each build | Root `eve build` calls `buildApplication` for each member (**new wiring**)                                |
| Run a workspace               | `startProductionServer` per agent, plus public routes `/eve/<name>/v1/*`                 | Vercel services and path transforms                 | `startWorkspaceHost`: one process per member on loopback, plus a streaming router (**new**)               |
| Peer discovery and invocation | `defineWorkspaceAgent` → `defineRemoteAgent` (`url`, `auth`)                             | `VERCEL_URL` + Vercel OIDC                          | Host-provided `EVE_WORKSPACE_PEERS` + HS256 token from `EVE_WORKSPACE_SECRET` (**new default transport**) |
| Peer identity at the callee   | `AuthFn` in channel auth; `verifyJwtHmac`                                                | `vercelOidc()`                                      | `workspacePeers()` (**new, experimental**). The caller is the service principal `eve-workspace:<agent>`   |
| Authority propagation         | `forwardPrincipal` + `trustedForwarders`                                                 | Same                                                | Same; unchanged and opt-in on both sides                                                                  |
| Callback delivery             | Callback URL validation and SSRF-guarded delivery                                        | Public deployment URLs                              | Exact-origin allowlist `EVE_CALLBACK_ALLOWED_ORIGINS` (**new**); private ranges stay blocked              |
| Durable scheduling            | `ScheduleProvider`; Workflow world (`sleep`, hooks, runs); `dispatchScheduledOccurrence` | Vercel Schedules + Queues                           | `workflowScheduleProvider()`: one durable workflow run per schedule (**new provider**, no new store)      |
| Tracing                       | `otel()` / `otelIntegration()` with any `SpanExporter`                                   | Agent Runs (in-process Vercel request context)      | Any OpenTelemetry exporter. Unchanged; now proven by test                                                 |
| Durable execution history     | Workflow world event log (local SQLite / Postgres)                                       | Vercel Workflow                                     | Local or Postgres world. Unchanged                                                                        |
| Model metadata                | Catalog loader → `model-metadata.json`                                                   | `ai-gateway.vercel.sh` catalog                      | Bundled snapshot (generated, vendored) and `EVE_MODEL_CATALOG=bundled` (**new**)                          |
| Sandbox preparation           | `SandboxProvider.prepare` at build; readiness check at `eve start`                       | Vercel Sandbox snapshots                            | Docker on the build daemon; **separating build and runtime hosts is not implemented** (see gaps)          |
| Controlled application update | None exists                                                                              | None: deployed self-modification opens a draft PR   | Not implemented (see `EVE-SELF-MODIFICATION.md`)                                                          |

## What belongs in traces versus authoritative state

- **Workflow world (authoritative).**
  - The Workflow world, local SQLite or Postgres, is authoritative for sessions, turns, deliveries, delegation tasks, and schedules. Schedule records are hook metadata owned by a live run.
  - Delegation results arrive as callbacks recorded in the caller's run.
- **Traces (diagnostic, best effort).**
  - Spans are exported in batches and can be dropped by the exporter.
  - Content is redacted by default outside public audiences.
  - Nothing in eve reads traces back to decide behavior.

## Boundary rules this slice enforces

- No self-hosted path needs a Vercel account, credential, CLI, identity, or service. The acceptance scenarios strip every `VERCEL*` variable and the Vercel CLI from `PATH`, and use `EVE_MODEL_CATALOG=bundled`.
- The Vercel paths are untouched: same code branches when `VERCEL` is set. The `vercel-build-prewarm`, Vercel world selection, and `production-build` Vercel-output tests still pass.
- An agent invoked by a peer never inherits a user's authority implicitly. It runs as `eve-workspace:<caller>`, a `service` principal, unless its own channel's `trustedForwarders` accepts a forwarded principal.

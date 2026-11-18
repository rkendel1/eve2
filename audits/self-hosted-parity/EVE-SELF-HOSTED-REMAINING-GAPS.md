# Self-hosted: remaining gaps

Ordered by value to a self-hosted user.

## Decisions that need an owner

1. **Default model for non-interactive `eve init`.** It still writes an AI Gateway string; the routing is now printed. Making `-n` require an explicit provider, or default to a direct one, is a compatibility change for coding-agent flows. See `EVE-DEFAULT-MODEL-DECISION.md`.
2. **Enable the real-model CI test.** Add the `EVE_ACCEPTANCE_ANTHROPIC_API_KEY` repository secret. Until then, real model execution is proven only locally in this session.

## Limitations that are characterized, not fixed

| Capability                                   | Status after this slice                                                                                                              | Why not fixed here                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker sandbox templates prepared at runtime | Not possible. The template must be prepared by `eve build` on the daemon the server uses. `eve start` now reports when it is missing | Lazy production preparation is a deliberate design (`never prepares them in production`); changing it is an architectural decision with startup-latency and failure-mode costs |
| Docker sandbox across several hosts          | A sandbox lives on one daemon; a replica on another host starts fresh or fails                                                       | Needs a remote or custom provider                                                                                                                                              |
| `fileMemory()` default backend               | Still throws off Vercel and off `eve dev`; `localFiles()` is the documented single-server option                                     | A silent disk default diverges across Postgres-world replicas                                                                                                                  |
| `localFiles()` across processes              | Compare-and-set holds within one process only                                                                                        | Cross-process file locking would add platform-specific code; the local world already requires one process per directory                                                        |
| Multi-agent workspace root build             | Vercel Build Output only. Members self-host individually, and the build prints how                                                   | A combined self-hosted server needs a new routing component; the existing per-member path works                                                                                |
| Default workspace-peer transport             | Requires Vercel; explicit transports work                                                                                            | Unchanged                                                                                                                                                                      |
| Experimental dynamic schedules               | Default provider is Vercel-only; users implement `ScheduleProvider`                                                                  | Static schedules cover the baseline. A self-hosted provider needs a clock and persistence design, and no evidence showed the existing abstractions are insufficient            |
| Deployed self-modification                   | Vercel-only                                                                                                                          | Niche; unchanged                                                                                                                                                               |
| Agent Runs observability                     | Vercel-only; OpenTelemetry is the self-hosted path                                                                                   | Unchanged                                                                                                                                                                      |
| Build-time model catalog                     | Fetched from `ai-gateway.vercel.sh`; offline builds warn, and dynamic models then need `modelContextWindowTokens`                    | Unchanged                                                                                                                                                                      |
| Scaffold Vercel defaults                     | `@vercel/connect` dependency, `.vercelignore`, `deploy` script, Vercel-flavored README and AGENTS.md copy                            | Cosmetic; changing upstream scaffold copy is a product call                                                                                                                    |

## Not verified

- A remote deployment of the Node server, and TLS or reverse-proxy behavior.
- The Postgres world and multiple replicas.
- Windows and macOS hosts.
- An actual Vercel deployment. The Vercel world and prewarm scenarios and the `production-build` Vercel output tests pass, but nothing was deployed.
- Static schedules running under `eve start` (code-read only in this slice).

## Highest-value next steps

1. Add the CI secret and watch the first run of the credential-gated test.
2. A Postgres-world variant of the acceptance test (CI already has `e2e-postgres.yml`).
3. Decide on the `eve init -n` default.
4. A durable self-hosted `ScheduleProvider` only if a user needs dynamic schedules. Then evaluate AppBoundry as an optional deployment adapter on top of `eve build` + `eve start`, the contract this slice made explicit and tested.

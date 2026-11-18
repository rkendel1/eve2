# Self-hosted acceptance

## The automated acceptance tests

Two scenario files run in the existing CI job `test-scenario` (`pnpm test:scenario`). No new job, platform or service was added.

### `packages/eve/test/scenarios/self-hosted-acceptance.scenario.test.ts`

**Setup.** One app is materialized on disk with real dependencies installed:

- `model: anthropic(...)` from `eve/models/anthropic`;
- auth `[jwtHmac(HS256), localDev(), placeholderAuth()]`.

It is built in-process with every `VERCEL*` variable and `AI_GATEWAY_API_KEY` removed, and with `EVE_DEVELOPMENT_LINUX_DOCKER_AVAILABLE=0` to simulate a build host without Docker. The server runs as a real `eve start` child process with a scrubbed environment:

- no `VERCEL*`, no `*_API_KEY`;
- `PATH` limited to the Node binary directory and system directories, so no Vercel CLI;
- `NODE_ENV=production`, authored-model mocking off.

| Test                                                                 | Credential                         | Proves                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| builds a Node server and no Vercel output                            | none                               | `.output/server/index.mjs` exists; `.vercel/` does not                                                                                                                                                                                                       |
| starts, reports health, and enforces JWT HMAC route auth             | none                               | Health returns `200 {ok:true,status:"ready"}`. `sandbox: none…` is logged. Anonymous request → 401 `eve_production_auth_not_configured`. Wrong secret → 401. Wrong audience → 401. Valid HS256 token → 202 with a session id. Still no `.vercel/` afterwards |
| runs a real Anthropic turn and continues the session after a restart | `EVE_ACCEPTANCE_ANTHROPIC_API_KEY` | Real Anthropic turn completes. The server is `SIGKILL`ed and restarted on the same `.eve/.workflow-data`. A follow-up on the same session answers `PELICAN-42`, which only the persisted history contains. Skipped when the secret is absent                 |

### `packages/eve/test/scenarios/self-hosted-runtime.scenario.test.ts`

**Setup.** A deterministic `mockModel` agent with `fileMemory({ backend: localFiles() })` and a per-run unique Docker sandbox env, so the test owns its template image. It is built with Docker available. No credential is needed.

| Test                                                                           | Proves                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reports a ready template at startup and runs bash in a Docker container        | `eve start` logs `sandbox: docker template eve-sandbox-template:… is ready.`. A `bash` tool call runs `uname -s && echo selfhost-sandbox-ok` in the container, and the reply contains `Linux` and `selfhost-sandbox-ok` |
| keeps localFiles() memory across an eve start restart                          | Session 1 saves a memory entry; `.eve/memory` holds one file. After a kill and restart, a **new** session's prompt contains the saved entry                                                                             |
| warns at startup when the runtime daemon lacks the template the build prepared | After the template image is deleted, `eve start` logs `template image … is missing on this Docker daemon` and health stays 200                                                                                          |

## What credential-free CI proves, and what it does not

**Proven without secrets, on every CI run:**

- Production build without Vercel.
- Node server startup and health.
- `jwtHmac` acceptance and rejection.
- The placeholder 401.
- The startup sandbox diagnostics: none, ready, and missing image.
- A real Docker sandbox tool execution.
- `localFiles` memory persistence across a restart.

These use a mock _model_ but real servers, real Docker and real disk.

**Proven only when `EVE_ACCEPTANCE_ANTHROPIC_API_KEY` is configured:**

- A real model call.
- Session continuation through a real model after a restart.

Without the secret the test reports **skipped**. Nothing claims it passed.

**Not covered by CI:**

- A remote deployment.
- TLS and reverse proxies.
- The Postgres world.
- Multiple replicas.
- Windows and macOS self-hosting.

### Secret handling

- The workflow passes the secret only to the `Run scenario tests` step. GitHub does not expose it to pull requests from forks, so the test skips there.
- The test passes it to the child server as `ANTHROPIC_API_KEY`, and strips every `*_API_KEY` and `EVE_ACCEPTANCE_*` variable from the inherited environment first.
- Assertion messages include server stderr, never the key. In both real-key runs here, `grep -c <key>` on the full test log returned `0`.

### To enable the real-model test

Add a repository secret `EVE_ACCEPTANCE_ANTHROPIC_API_KEY`, scoped to an Anthropic key with low limits. Set `EVE_ACCEPTANCE_ANTHROPIC_MODEL` to override the default `claude-sonnet-5`.

## Results in this session (Node 26.13.1, Linux, local Docker 29.10.0)

| Gate                                                                                          | Result                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `oxfmt --check`                                                                               | Pass                                                                                        |
| `oxlint`                                                                                      | No findings in changed files; one pre-existing warning in `apps/templates/…/code-block.tsx` |
| `turbo typecheck --filter=eve`                                                                | Pass                                                                                        |
| Unit tier                                                                                     | 939 files, **9,332 passed**, 0 failed, 1 expected-fail, 1 skipped                           |
| Integration tier (keys unset)                                                                 | 219 files, **2,675 passed**, 0 failed, 785 skipped (pre-existing conditional skips)         |
| Scenario tier (keys unset)                                                                    | 76 files, **361 passed**, 1 failed (pre-existing; see below), 1 skipped (credential-gated)  |
| Build tier, `production-build` project (includes Nitro and Vercel output builds)              | 20 files, **121 passed**                                                                    |
| Public declaration types                                                                      | 26 passed                                                                                   |
| `guard:invariants`, `guard:docs-budget`, `docs:check`, public export snapshots, fixture guard | All pass                                                                                    |
| Self-hosted scenarios **with** the real Anthropic key                                         | **6/6 passed**, key absent from the log                                                     |

### Failures classified

| Failure                                                                                                             | Classification                                  | Evidence                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup/primitives/pm/run.scenario.test.ts` "installs standalone without executing an unclaiming ancestor workspace" | Pre-existing, environmental (container pnpm)    | Fails identically on the unmodified base commit `1eb96d5`                                                                                                                                                                                                                                          |
| `cli/dev/tui/setup-issues.integration.test.ts` "points an unconnected model at /login…"                             | Environmental                                   | Fails only when the shell exports `AI_GATEWAY_API_KEY`/`OPENAI_API_KEY`; passes 7/7 with them unset                                                                                                                                                                                                |
| `agent-info-route.scenario.test.ts` "returns 401 … without a Vercel OIDC bearer token"                              | **Regression from this slice, fixed**           | My first `placeholderAuth` change dropped the `www-authenticate: Bearer` challenge. I rejected a general `routeAuth` change because existing tests encode that thrown rejections are authoritative. The placeholder now declares `Bearer` itself, and a unit test pins the default policy's header |
| 83 scenario failures in one intermediate run                                                                        | Self-inflicted build-state corruption, not code | Manual packaging left `dist/` resolving `#imports` to `dist/dist/…`. After a forced clean rebuild, the tier returned to the single pre-existing failure                                                                                                                                            |
| `pnpm build:eve`, `pnpm pack` prepack: `Exec format error`                                                          | Container quirk                                 | `npx turbo …` and `npm pack` in `.package/` work                                                                                                                                                                                                                                                   |

## Real execution outside the test suite

Run on a generated project from `eve init` against a packed tarball of this branch, with a scrubbed environment:

| Check                                                                                               | Observed                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `eve init plain -n`                                                                                 | Printed the model, its AI Gateway routing, and the `eve set model anthropic-api/…` switch                           |
| `eve set model anthropic-api/claude-sonnet-5` on that project                                       | Rewrote `agent.ts` to `anthropic("claude-sonnet-5")`                                                                |
| Explicit `DockerSandbox.environment()` built with no Docker (`EVE_DOCKER_PATH=/nonexistent/docker`) | `eve build` exit 1: "the `docker` CLI was not found". This contradicted the published docs, which are now corrected |
| `eve init ws --agents support,research` → root `eve build` without `VERCEL`                         | Wrote `.vercel/output` and printed the self-hosting hint with both member commands                                  |
| `(cd agents/support && eve build)`                                                                  | Wrote `agents/support/.output` with no `.vercel/`                                                                   |
| `eve start` on that member (unmodified scaffold)                                                    | Health 200; `sandbox: none…`; `POST /eve/v1/session` → 401 `eve_production_auth_not_configured`                     |

## Code added

| Category                                  | Lines added / removed                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Production (`packages/eve/src`, non-test) | +278 / −9. Of these, `sandbox-readiness.ts` 125 and `local-files.ts` 88 are new files; the rest is small edits across 7 files |
| Tests                                     | +815 / −26                                                                                                                    |
| Published docs                            | +33 / −16                                                                                                                     |
| Audit reports                             | +313                                                                                                                          |
| CI, changesets, export snapshot           | +24 / −1                                                                                                                      |

Reused rather than rebuilt:

- the scenario harness, the Docker CLI driver, and the prepared-artifact schema;
- the `MemoryDocumentBackend` contract and `resolveInstrumentationEnvironment`;
- the `parseModelHelper` and `eve set model` source rewrite;
- the existing CI job.

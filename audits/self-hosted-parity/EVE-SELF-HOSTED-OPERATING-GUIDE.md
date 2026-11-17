# Self-hosted eve operating guide

This is the operating contract for running eve 1.0.2 on your own machine or servers **without a Vercel account**. Every setting below exists in the code at this commit. The status column says how each claim is backed:

- **Tested**: an automated test exercises it.
- **Run**: it was executed during this slice.
- **Code**: verified by reading the implementation.

Published docs carry the details. This guide links to them instead of repeating them.

## 1. Node and installation

| Item       | Value                                                                                                       | Status                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Node       | `>=24` (`engines`). CI uses 26.13.1 (`.nvmrc`)                                                              | Run on 24.22.3 and 26.13.1               |
| Install    | `npm i eve` in an existing project, or `npx eve@latest init <dir> --model anthropic-api/claude-sonnet-5 -n` | Run                                      |
| Vercel CLI | Not needed by `init`, `build`, `start`, `dev`, `eval`                                                       | Tested (scenario PATH has no Vercel CLI) |

The scaffold adds `@vercel/connect` as an npm dependency. It needs no Vercel account and is unused unless you call it.

## 2. Model provider

Pick a direct provider when you scaffold:

```bash
npx eve@latest init my-agent --model anthropic-api/claude-sonnet-5 -n
```

This writes `model: anthropic("claude-sonnet-5")` from `eve/models/anthropic`, which reads `ANTHROPIC_API_KEY`. `openai-api/<id>` does the same with `openai()` and `OPENAI_API_KEY`. **Tested**, and **Run** against the real Anthropic API.

An existing project switches with `eve set model anthropic-api/claude-sonnet-5` (**Run**). Any AI SDK provider model object also works; see `docs/agent-config.md#set-the-model`.

A string such as `"anthropic/claude-sonnet-5"` routes through **Vercel AI Gateway** and needs `AI_GATEWAY_API_KEY`. `eve init` prints which routing the scaffold uses.

## 3. Route authentication

Production routes reject callers until you configure auth. A scaffold whose `placeholderAuth()` is still in place answers with a 401 that names the fix, on any non-dev server (**Run** on an unmodified scaffold):

```json
{
  "code": "eve_production_auth_not_configured",
  "error": "Production auth is not configured. Replace placeholderAuth() in agent/channels/eve.ts with your app's auth provider, such as jwtHmac(), httpBasic(), oidc(), or vercelOidc().",
  "ok": false
}
```

A provider-neutral policy, **Tested** end to end on `eve start`:

```ts title="agent/channels/eve.ts"
import { jwtHmac, localDev, placeholderAuth } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    jwtHmac({
      algorithm: "HS256",
      audiences: ["my-agent"],
      issuer: "my-issuer",
      secret: process.env.ROUTE_JWT_SECRET ?? "",
    }),
    localDev(),
    placeholderAuth(),
  ],
});
```

What the test proves:

- `localDev()` stays closed in production.
- No token, a token signed with another secret, or a token for another audience each get 401.
- A valid HS256 token is accepted.

No helper reads its secret from the environment implicitly; pass it as shown. `httpBasic()`, `jwtEcdsa()` and `oidc()` are the other built-in helpers. See `docs/guides/auth-and-route-protection.md`.

## 4. Environment variables

`eve build` and `eve start` load `.env.development.local`, `.env.local`, `.env.development` and `.env` from the project root. Variables already set in the process take precedence. **Code**: `cli/dev/environment.ts`.

| Variable                                     | Required                                       | Purpose                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`       | For direct models                              | Provider credential                                                                                                        |
| Your auth secret (e.g. `ROUTE_JWT_SECRET`)   | Yes, for production                            | Read by your channel file                                                                                                  |
| `PORT`                                       | No                                             | Listen port; `--port` wins; default 3000                                                                                   |
| `WORKFLOW_LOCAL_BASE_URL`                    | When using connection sign-in or remote agents | Public origin for callbacks                                                                                                |
| `EVE_PUBLIC_ROUTE_PREFIX`                    | When mounted under a path                      | Path prefix                                                                                                                |
| `EVE_SCHEDULES_DISABLED=1`                   | No                                             | Disable schedules (same as `--no-schedules`)                                                                               |
| `WORKFLOW_POSTGRES_URL`                      | With the Postgres world                        | Database                                                                                                                   |
| `EVE_DOCKER_PATH`, `DOCKER_HOST`             | No                                             | Which `docker` binary and daemon the sandbox uses. `DOCKER_HOST` is read by the Docker CLI, which inherits the environment |
| `EVE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` | No                                             | Force CLI telemetry off (it is off by default)                                                                             |

No `VERCEL*` variable is required. The acceptance tests strip them all.

## 5. Build and start

```bash
eve build
eve start --host 0.0.0.0 --port 3000
```

- `eve build` without `VERCEL` writes a Nitro Node server to `.output/` and no `.vercel/` (**Tested**).
- `eve start` serves `.output/`, waits for its health route, and then logs the following. **Tested**:

```
[START] server listening at http://…
[START] sandbox: docker template eve-sandbox-template:… is ready.
```

To run elsewhere, copy the app source, `.output/` and `node_modules/` together (`docs/guides/deployment/self-hosting`).

## 6. Persistence: the local Workflow world

- Sessions, history, queues and pending input live in SQLite at `.eve/.workflow-data/world.db`.
- A killed `eve start` restarted on the same directory resumes the same session. **Tested** with a real Anthropic model: the session recalled a codeword after a `SIGKILL` restart.
- Run **one** `eve start` process per `.eve/.workflow-data`, on a persistent volume.
- For replicas, use the Postgres world (`docs/guides/deployment/workflow-worlds.md`); that is not exercised by this slice.
- **Backup:** stop the process and copy `.eve/.workflow-data`, or use SQLite `.backup` on the live `world.db`.

## 7. File memory

`fileMemory()` has no default backend off Vercel and off `eve dev`; it throws, and the error names the fix. On one server:

```ts title="agent/memory/file.ts"
import { defineMemory } from "eve/memory";
import { fileMemory, localFiles } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  provider: fileMemory({ backend: localFiles() }),
  scope: byPrincipal,
});
```

- Storage is one file per scope under `.eve/memory`, or `localFiles({ directory })`.
- Writes are atomic (temp file plus rename).
- Stale writes raise `MemoryDocumentConflictError`. That conflict check holds **within one process only**.
- Back the directory up with the world data.
- A saved entry survives an `eve start` restart. **Tested**.

## 8. Docker sandbox

**Build-time prerequisite.** `eve build` must reach the Docker daemon that the server will use. It prepares a template image there, `eve-sandbox-template:<key>`, based on `ghcr.io/vercel/eve:<tag>`, which is pulled anonymously.

**Runtime prerequisites.** The same daemon must be reachable and must still have that image. The runtime never recreates a template.

What `eve start` reports, all **Tested**:

| `sandbox:` line                                   | Meaning                                               |
| ------------------------------------------------- | ----------------------------------------------------- |
| `docker template … is ready.`                     | Daemon reachable and template present                 |
| `none. This build recorded no sandbox provider…`  | Docker was unreachable during `eve build`             |
| `docker, but the Docker daemon is not reachable…` | Runtime daemon down, or the CLI is missing            |
| `docker, but template image … is missing…`        | Image deleted, or a different daemon from the build's |

A Dockerfile `RUN eve build` has no daemon. Build on the target daemon's host and copy `.output/`, or move the image with `docker save` / `docker load`. Do not select `DockerSandbox.environment()` to work around a missing daemon: that build fails (**Run**).

A bash tool call executing inside the container is **Tested** with a deterministic mock model.

Isolation: Docker supports the `"allow-all"` and `"deny-all"` network policies. There is no fallback to host execution.

## 9. Schedules

`agent/schedules/*` run inside `eve start` as Nitro scheduled tasks. Run them on one process; start others with `--no-schedules`. **Code**: `internal/nitro/host/host-routes.ts`. Not exercised by this slice's tests.

Experimental dynamic schedules have no self-hosted provider; see the remaining gaps.

## 10. Logs, telemetry, health

- Server logs go to stdout/stderr; collect them with your process manager.
- CLI telemetry is off unless `eve telemetry enable`. Agent Runs tracing is only active on Vercel. OpenTelemetry is registered only when you declare it (`docs/observability/otel`).
- `GET /eve/v1/health` is public and returns `{"ok":true,"status":"ready",…}`. Use it for liveness. **Tested**.
- `GET /eve/v1/info` needs an operator (`service`) caller, which `jwtHmac()` provides.

## 11. Reverse proxy and TLS

- Terminate TLS at your proxy.
- Forward both `/eve/` and `/.well-known/workflow/` without rewriting. If only `/eve/` is forwarded, runs stall.
- Keep one process behind the origin when using the local world.

Details are in `docs/guides/deployment/self-hosting#configure-proxy-routes`. These are documented behaviors, not tested here.

## 12. Update procedure

1. Stop the running process.
2. Deploy the new build.
3. Rebuild on the daemon host if the sandbox config changed.
4. Run `eve start`.

A new build on the **same eve version** resumes active sessions. **Upgrading eve strands** sessions from the previous version: their history stays readable, and a new message starts a replacement session (`docs/guides/deployment/self-hosted-operations.md`).

## 13. Unsupported self-hosted, or Vercel-only

| Capability                           | Status                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-agent workspace **root** build | Writes Vercel Build Output only. Self-host by building and starting each member in its own directory; `eve build` prints the commands |
| Default workspace-peer transport     | Requires Vercel; configure an explicit transport                                                                                      |
| Experimental dynamic schedules       | Default provider is Vercel-only; implement `ScheduleProvider`                                                                         |
| Deployed self-modification           | Vercel-only                                                                                                                           |
| `eve deploy`, `eve link`             | Vercel-only commands                                                                                                                  |
| `fileMemory()` with no backend       | Error off Vercel and off `eve dev`; use `localFiles()` or a shared backend                                                            |
| Agent Runs observability             | Vercel-only; use OpenTelemetry                                                                                                        |

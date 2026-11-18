# Self-hosted multi-agent workspaces and agent-to-agent calls

## What ships

**Root `eve build` off Vercel.**

- Still writes the Vercel workspace config, which is cheap and unchanged.
- Also builds every member as a Node server, with the same `buildApplication` options a member build from its own directory gets.

**Root `eve start` without `--agent`** runs `startWorkspaceHost`. It:

1. Loads the workspace root's env files once.
2. Reads each member's own env files **without** applying them to the parent, so member A's secrets never reach member B. Precedence: member files, then the process environment, then host-owned variables.
3. Allocates a loopback port per member up front.
4. Starts each member with `startProductionServer` and per-member variables:

   | Variable                       | Value                                                          |
   | ------------------------------ | -------------------------------------------------------------- |
   | `EVE_WORKSPACE_AGENT`          | The member's name                                              |
   | `EVE_WORKSPACE_PEERS`          | Name → origin for every member                                 |
   | `EVE_WORKSPACE_SECRET`         | Operator-provided (minimum 32 characters), or random per start |
   | `EVE_CALLBACK_ALLOWED_ORIGINS` | All member origins                                             |
   | `WORKFLOW_LOCAL_BASE_URL`      | The member's own origin                                        |

5. Serves a streaming router on the public port:
   - `/eve/<name>/v1/*` → member `/eve/v1/*`, the same public paths as Vercel workspaces;
   - `/eve/v1/health` reports each agent and returns 503 if any member stopped;
   - unknown agent → 404 `agent_not_found`; stopped agent → 503 `agent_unavailable`.
6. Prints each member's sandbox readiness.

`eve start --agent <name>` keeps its previous single-agent behavior.

**Default peer transport off Vercel.** `defineWorkspaceAgent({ name })` with no transport:

- resolves the peer's origin from `EVE_WORKSPACE_PEERS`;
- authenticates with an HS256 JWT minted per request: `iss=eve-workspace`, `aud=eve-workspace:<callee>`, `sub=<caller>`, 5-minute expiry.

On Vercel the transport is unchanged. Outside both, it throws an actionable error that names the options.

**`workspacePeers()`** (from `eve/experimental/workspace`, and in the default channel policy) verifies that token with the existing `verifyJwtHmac`:

- it accepts only tokens whose audience is this agent;
- the caller becomes the `service` principal `eve-workspace:<caller>`;
- it returns `null` outside a workspace host.

**Callback allowlist.** `EVE_CALLBACK_ALLOWED_ORIGINS` exempts **exact origins** (scheme, host and port) from the loopback block, both when accepting a callback URL and when delivering to it. Private, link-local and reserved ranges stay blocked. The URL in a request is still untrusted input; only operator- or host-configured origins pass.

**Build-time fix.** Sandbox prewarm no longer resolves remote-agent URLs: `resolveRemoteAgentUrls: false`. URLs that exist only at runtime no longer break `eve build`. Runtime graph resolution is unchanged and strict.

## Contract

| Concern                  | Behavior                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery                | Compile time: `defineWorkspaceAgent` names are validated against `agents/` (existing). Runtime: `/eve/v1/health` lists agents and their status                       |
| Invocation               | The existing remote-agent protocol: create session, then asynchronous result through a callback (`<task_result>`)                                                    |
| Identity                 | The caller is `eve-workspace:<name>`, a `service` principal. A token for agent A is rejected by agent B                                                              |
| Authority                | No user authority crosses unless the callee's `trustedForwarders` accepts `forwardPrincipal` (existing, opt-in)                                                      |
| Session isolation        | Each agent has its own process, Workflow world, sessions, env, and sandbox                                                                                           |
| Failure                  | A failing delegated turn returns `status="failed"` to the caller. A stopped peer makes new delegations fail fast (create retries, then `failed`) and shows in health |
| Timeout and cancellation | Unchanged from remote agents: parent cancellation ends the remote session; create and continue requests have no timeout                                              |
| Recursion                | No dispatch-depth limit exists in eve, on Vercel or self-hosted; the root session's token cap applies                                                                |

## Evidence: `test/scenarios/self-hosted-workspace.scenario.test.ts`

Real CLI `eve build` and `eve start` with a scrubbed environment. Mock models; real processes, HTTP, auth, callbacks and Workflow worlds. 7/7 pass.

| Test                                                                       | Proves                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| builds every member as a Node server from the workspace root               | Both `.output/server/index.mjs` exist                                                                                                                        |
| serves every agent from one origin and reports each one's health           | Aggregate health lists both agents; each agent's health returns 200; unknown agent → 404                                                                     |
| delegates to a peer that runs as the calling agent, not as the end user    | coordinator → research → coordinator round trip. Research's `whoami` tool reports `eve-workspace:coordinator` / `service`; the end user's name never appears |
| exports nested and linked traces through OpenTelemetry without Vercel      | See `EVE-OBSERVABILITY.md`                                                                                                                                   |
| rejects callers that are not workspace peers                               | No auth → 401; Basic auth valid for coordinator → 401 at research; wrong secret → 401; token for another agent → 401; correct token → 202                    |
| returns a delegated agent's failure to the caller                          | Research's model throws; the coordinator receives `status="failed"`                                                                                          |
| reports a stopped peer in workspace health and fails new delegations to it | Research's process exits; health → 503 and `agent_unavailable`; a new delegation fails; the coordinator stays healthy                                        |

Unit tests (`internal/workspace/peer-auth.test.ts`, 11) cover:

- the token round trip;
- audience, secret and expiry rejection;
- no admission outside a host;
- short-secret rejection;
- peer-map parsing;
- exact-origin allowlist matching;
- the default transport off Vercel;
- an unknown peer.

## Limits, stated plainly

- The host does not restart a crashed member; the process manager restarts the whole workspace.
- A delegated agent that dies _mid-task_ leaves the caller's task pending until that agent comes back and its run resumes. eve has no remote-task timeout on any platform.
- Member callback origins are loopback, so features that need a public callback origin need separately run members. Those features are connection sign-in, and remote agents outside the workspace calling back.
- One host process per workspace directory, inherited from the local world.
- Not tested: the Postgres world with workspace members, and a workspace behind a TLS proxy.

# eve AppPort agent: AuthBoundry delegation

This slice replaces the example's shared-secret caller assertion with AuthBoundry delegated authority. The shared-secret path is gone, along with `principals.json`. No custom token, identity registry or authorization engine remains.

| Item                 | Version or details                                                  |
| -------------------- | ------------------------------------------------------------------- |
| Branch               | `claude/dreamy-galileo-4z03p5`, building on `fcb552a` and `3087291` |
| `@authboundry/local` | 0.1.1                                                               |
| `@authboundry/core`  | 1.20.0 (native server bundled for linux and darwin, x64 and arm64)  |
| `@appport/sdk`       | 1.9.0 (`@appport/core` 1.8.0, `@appport/authorization` 1.2.0)       |
| Node                 | 26.13.1                                                             |

## Flow

```
person --JWT--> eve (jwtHmac: authentication) --> appport_invoke tool
   Bearer <agent credential> + x-appport-on-behalf-of: <eve principal>
        v
AppPort host  authenticate: credential == application's custody copy for agent:appport-agent
              (proves the agent; grants nothing)
        v
              Authorizer "authboundry": for each declared permission
              POST /_authboundry/authorize/check (check credential + agent credential + on_behalf_of)
              allow + delegation_id -> run; anything else -> FORBIDDEN; unreachable -> INTERNAL_ERROR
        v
              handler (writes an execution record carrying the delegation id)
```

- AuthBoundry is plugged in through AppPort's existing `Authorizer` contract.
- Its decision is returned as AppPort's `AuthorizationDecisionReference`, with `decisionId = decision_id` and `evidenceId = delegation_id`.
- Grants use `@authboundry/local`'s `grant` and `revoke`, naming the registered agent `agent:appport-agent`. A grant to the application's executor, or to any other agent, never allows this one.

## Phase 1: the real server, measured here

| Property                            | Observed                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Processes                           | The native `authboundry` binary plus Node `feltdb-store` storage bridges (6 to 7 processes) in their own process group, on loopback only                                                                                 |
| Cold start to ready                 | 0.78 s. `GET /ready` returns `{"ready":true}` and `GET /health` returns 200                                                                                                                                              |
| Crash of the server                 | Restarted by `@authboundry/local` on the same port and state after a 500 ms backoff (exponential up to 30 s); ready again in about 0.93 s. Calls during the gap get `ECONNRESET`                                         |
| Clean shutdown                      | `close()` takes about 3 ms; `SIGTERM` to the host stops the whole group                                                                                                                                                  |
| **Abrupt death of the owning host** | **The server is orphaned and keeps running. Restarting the host starts a second server on the same state directory.** See defect 1                                                                                       |
| Persistence                         | Grants, the check credential and the agent credential survive a restart when the application passes back what it stored                                                                                                  |
| Decisions                           | Every reason in the package README reproduced: `delegation_missing`, `delegation_revoked`, `delegation_expired`, `agent_credential_required`, 401 `invalid_agent_credential`, 403 `agent_not_active` after `revokeAgent` |
| Credential renewal                  | The successor works. Replaying the superseded credential returns 401 `agent_credential_replayed` and revokes the successor too (`agent_credential_revoked`)                                                              |

**Platform requirements.**

- Linux or macOS, x64 or arm64, with Node 20.11 or later.
- A writable persistent directory, and a free loopback port.
- `@authboundry/core` installs at 57.6 MB unpacked, since it carries every platform's binary.
- It depends on `@feltdb/core` 0.22.0, `@appport/services` 0.20.0, `@appport/core` 1.8.0 and `@mailerport/sdk`.

**How personalOS uses it.** FeltKit's `authority: { local: true }` starts `@authboundry/local` inside the application, keeps its secrets in FeltKit custody, and lets each person set their own grants in Settings (`feltkit/_delegation.ts`). It acts as the executor `agent:personalos`. This example follows the same ownership, with one difference: the eve agent is a registered agent, so a person's grant names it specifically.

## Phase 3: evidence

All of this is in `examples/appport-agent/test/acceptance.test.mjs` and runs against the real AppPort and AuthBoundry servers. Every rejected call is also checked to have **no `execution` record**, which proves the protected handler never ran.

| Requirement                                       | Test                                                  | Observed outcome                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alice can grant the agent the capability          | `invokes for Alice once she grants…`                  | Output equals `catalog.json`; provenance carries the agent, Alice, `decisionId` and `delegationId = grant.id`                                                          |
| Bob can't use Alice's delegation                  | `does not let Bob use Alice's delegation`             | `FORBIDDEN`, `delegation_missing`                                                                                                                                      |
| A user without a grant is rejected                | `rejects a user who has granted nothing`              | `FORBIDDEN`, `delegation_missing`                                                                                                                                      |
| Revocation stops the next call                    | `stops invoking once Alice revokes…`                  | `delegation_revoked`; a new grant gets a new id                                                                                                                        |
| An expired delegation is rejected                 | `rejects a delegation once it has expired`            | `delegation_expired`                                                                                                                                                   |
| A forged caller credential is rejected            | `treats a forged agent credential as unauthenticated` | `UNAUTHORIZED`; AuthBoundry is never asked                                                                                                                             |
| An AuthBoundry outage fails closed                | `fails closed while AuthBoundry is down…`             | `INTERNAL_ERROR` and an `unavailable` record; succeeds again after the automatic restart                                                                               |
| An AppPort outage is no false success             | `reports an unreachable AppPort…`                     | `ok: false`, `UNAVAILABLE`                                                                                                                                             |
| Invalid input is rejected                         | `rejects input that violates the contract`            | `INVALID_INPUT`                                                                                                                                                        |
| State survives an application restart             | `keeps grants and the agent's credential…`            | No credential reissued; the same delegation authorizes                                                                                                                 |
| End to end with the real model, including restart | The real-model suite                                  | 401 without a JWT; Alice is answered 42, then 7 in the same session after `SIGKILL` and restart, with the execution record carrying her delegation id; Bob is rejected |

**Results:**

- 16/16 with the real Anthropic model; 13/13 plus a skipped real-model suite without the key. The key appears 0 times in the log.
- A mutation check passed: swapping in an allow-all authorizer fails 8 tests.
- `revokeAgent` was verified by a probe against the real server, not in the suite, because it is final for the agent id.

## Defects and contract findings (reported, not worked around)

1. **`@authboundry/local`: the server is orphaned when its host dies abruptly, and nothing locks `dataDir`.**
   - The server runs `detached` in its own process group, so killing the host with `SIGKILL` (or an OOM kill) leaves it running under PID 1.
   - Restarting the host then starts a second server on the same state, and both run. Whether the state stays consistent is **unverified**.
   - Mitigation without a code change: a supervisor that kills the whole control group (systemd's default `KillMode=control-group`).
   - Fix in the package: lock the state directory and reap a previous server.
2. **AuthBoundry: an agent credential can't be copied between processes.** Renewal supersedes the credential, and replaying the old one revokes the whole family.
   - This is correct security behavior, and it decides custody: the application holds and renews the credential, and the agent reads the current one from a 0600 file.
   - The host compares the presented credential to its copy rather than forwarding it, so a stale copy can't revoke the family.
   - Consequence: the eve agent and the AppPort host must share a filesystem, or a secret store, for that file.
3. **AuthBoundry: delegation ids are derived, not globally unique.** The same person, agent, capabilities and expiry gave the identical id `g-e0577a…` in two independent state directories. Provenance should qualify a delegation id by its authority.
4. **AppPort has no `UNAVAILABLE` error code**, so an authority outage surfaces as `INTERNAL_ERROR`.
5. **AppPort's `TelemetryRecord` carries no decision or delegation.** The host writes a separate `authorization` record, joined by `requestId`.
6. **The published `@appport/client` 1.1.8 still drops `authorizationDecision`** (carried over from the previous slice). The host records it instead.
7. **Supply chain:** `@authboundry/core` 1.20.0 requires `@feltdb/core` 0.22.0, published within the release-age window. `@authboundry/*` and `@feltdb/*` are now exempt in `pnpm-workspace.yaml`, as `@appport/*` was.

## Remaining trust and gaps

- **Who names the person.** `on_behalf_of` comes from eve's verified principal, never from the model, but the agent process asserts it. A compromised agent process could act for anyone who has granted it, within those grants. Binding the person's own credential to each call would close this; it isn't done.
- **No person-facing grant surface.** Grants are made through `host.authority`, which is the application's API. People need a screen or an authenticated grant capability, as personalOS has. This was deliberately out of scope (no new AppPort capabilities in this slice).
- **Renewal race.** When the application renews the credential, roughly every 16 hours, a call that read the old file a moment earlier gets one `UNAUTHORIZED`. The agent does not retry.
- **Not cross-checked.** `decisionId` was not verified against AuthBoundry's own audit log.

## Phase 4: operational decision

**AuthBoundry, through `@authboundry/local`, is suitable as a supervised runtime dependency for a single-host deployment, under these conditions:**

| Concern                   | Decision                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process ownership         | The **AppPort application** (`appport-host/host.mjs`) starts and supervises it. The eve process does not; eve depends on AppPort only            |
| Lifecycle                 | Started with the host and restarted on crash by the package. The host must itself run under a supervisor with control-group kill (defect 1)      |
| Configuration and secrets | `AUTHBOUNDRY_ADMIN_SECRET` (32+ chars) from custody. The check credential and the agent credential are files (0600) in the host's data directory |
| Persistent state          | `APPPORT_HOST_DATA_DIR` on a persistent volume: AuthBoundry's own FeltDB state, the check credential, and the agent credential                   |
| Failure                   | Fail closed: no decision means no execution. Recovers once the server is back, in about 1 s after a crash                                        |

**On the existing Boundry host:** the requirements are listed above. I don't know that host's specifics, so running both services there is **unverified**.

**Multi-host deployment is not supported this way:** AuthBoundry listens on loopback only and needs one state directory. That case calls for a hosted AuthBoundry (`AUTHBOUNDRY_URL`, as personalOS supports), which this slice did not exercise.

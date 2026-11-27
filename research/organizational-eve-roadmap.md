---
issue: "none: organizational Eve as a production AppBoundry .app (working roadmap; no tracking issue yet)"
status: in-progress
last_updated: "2026-11-27"
---

# Organizational Eve as a production AppBoundry .app: roadmap

**Destination.** One organization-owned Eve:

- It runs as a genuine AppBoundry application (`appboundry.app/1`: Wasm module plus manifest).
- Every FeltKit application of that organization connects to it through `connect({ application, conversation })`.
- Applications supply context and explicitly authorized capabilities.
- People supply identity and authority on each delivery.
- Sessions survive host restarts.
- Nothing runs per application while Eve is idle.

**Storage principle.** AppBoundry uses FeltDB as its default durable state layer. It is not an integration an
application selects.

- Platform-owned state lives in host-reserved FeltDB collections that application-facing data operations cannot
  reach. That covers agent sessions and event streams, lifecycle and deployment metadata, platform-managed
  configuration, durable execution and recovery records, and the state of future capabilities.
- Each capability defines its own reserved namespace, access boundary, transaction semantics and lifecycle. It
  may expose narrowly scoped access to that state; sharing a database never grants an application access to it.
- Applications reach their own data only through their application-facing interfaces.
- Platform state lives wherever the organization's AppBoundry FeltDB lives. AppBoundry adds no second database
  or external persistence service for agent state.
- Eve stays storage-independent through `EveHostStore`. It takes no direct FeltDB dependency: AppBoundry's
  FeltDB-backed `sessions@1` is the default production store, and other hosts may supply others.

This document is the working plan:

- Update the **status table** (§5) as slices land.
- Do not rewrite the inventory without new evidence.

Evidence was gathered on 2026-11-26 from these commits:

| Repository             | Branch                           | Commit    | Note                                                         |
| ---------------------- | -------------------------------- | --------- | ------------------------------------------------------------ |
| `rkendel1/eve2`        | `main`                           | `07106ae` | the slice described in §1.1 is in the PR that adds this file |
| `rkendel1/appboundry`  | `claude/trusting-faraday-j5o0md` | `ac98b3f` | plus this PR's `experiments/eve-host-boa` changes            |
| `rkendel1/feltkit`     | `claude/trusting-faraday-j5o0md` | `945ffdb` |                                                              |
| `rkendel1/meetings`    | `claude/trusting-faraday-j5o0md` | `bc63791` |                                                              |
| `rkendel1/feltkit-eve` |                                  | `7a21e97` |                                                              |

Statuses used below:

- **Verified:** implemented, with passing tests on the target path.
- **Off-path:** implemented, but not verified on the target execution path.
- **Partial:** partially implemented.
- **Proposed:** a document or interface only.
- **Missing.**
- **Blocked:** waiting on another repository.

## 1. Current-state inventory

### 1.1 eve2: runtime

| Capability                                                                                                                                    | Status                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-independent interface: `createEveHost`, `connect({ application, conversation })`, host-supplied models, fetch, timers and `AsyncContext` | Verified                                                    | `packages/eve/src/public/experimental/host/index.ts`; `host.integration.test.ts`; Boa: `appboundry` `experiments/eve-host-boa/test/boa.test.mjs` (12/12)                                                                                                                                                                                                                                                                           |
| Neutral platform boundary for the guest                                                                                                       | Verified                                                    | `pnpm --filter eve check:host-neutral`                                                                                                                                                                                                                                                                                                                                                                                             |
| **Durable host sessions:** `createEveHost({ store })` (`EveHostStore`) and `EveHost.restoration`                                              | Verified (Node and Boa, separate OS processes with SIGKILL) | Implementation: `execution/in-process/session-store.ts`, `in-process/runtime.ts` (`restore`, `restoreEntry`), `in-process/host.ts`, and the `SessionCheckpointSink` hook in `execution/session/turn.ts`, called from `program.ts` and `turn.ts`. Tests: `public/experimental/host/host-restore.integration.test.ts` (one process, fenced store); `appboundry` `experiments/eve-host-boa/test/restart.test.mjs` (Node 3/3, Boa 3/3) |
| Restore covers                                                                                                                                | Verified                                                    | turn start, each continuing step, approval wait, idle wait. Completed effects are adopted, uncertain effects are reported and not re-run, unreadable checkpoints are refused and left intact.                                                                                                                                                                                                                                      |
| Restore does not cover                                                                                                                        | Missing                                                     | subagent child sessions, workflow-tool runs, timers, and deliveries accepted mid-turn but not yet consumed (`research/resumable-session-program.md`)                                                                                                                                                                                                                                                                               |
| Durable recovery on Node Workflow + FeltDB                                                                                                    | Off-path for `.app`                                         | rkendel1/eve2#36 and rkendel1/eve2#38; `test/scenarios/feltdb-restart-recovery.scenario.test.ts`. This is **not** evidence for the Wasm path.                                                                                                                                                                                                                                                                                      |
| A call's start is durable before the call runs                                                                                                | Verified on Workflow                                        | rkendel1/eve2#38. On the host interface, every store append is durable before it resolves (the `EveHostStore` contract).                                                                                                                                                                                                                                                                                                           |
| Session access by owner, plus `sessionAccess`                                                                                                 | Off-path                                                    | rkendel1/eve2#37. It is enforced on `eve/channels/eve` HTTP routes; the host interface has no HTTP routes. The owner key is restored with each host session.                                                                                                                                                                                                                                                                       |
| `eve/advance` (effects as data)                                                                                                               | Proposed                                                    | `research/resumable-session-program.md` §API. Not needed for the destination so far.                                                                                                                                                                                                                                                                                                                                               |

### 1.2 AppBoundry: platform

| Capability                                                                                                                                        | Status                         | Evidence                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appboundry.app/1` manifest, validator, loader, CLI (`run`, `verify`, `inspect`, `contract`)                                                      | Verified                       | `packages/appboundry-host/src/manifest.ts` (`ArtifactManifest`, `parseManifest`), `artifact.ts` (`loadArtifact`), `cli.ts`; `docs/artifact-formats.md`; tests `appboundry-host/test/artifact-host.test.ts`, `packages/appboundry/test/artifact-formats.test.ts` |
| Production guest execution (FeltKit Boa engine in Wasm, worker per instance, `abg_invoke`/`abg_resume`, limits)                                   | Verified                       | `appboundry-host/src/guest.ts`, `host.ts` `#operate`                                                                                                                                                                                                            |
| Host operations offered: `db.*`, `outbox.stage`, `events.stage`, `tenancy.read`, `crypto.token`, `service`, `capability.list`/`capability.invoke` | Verified                       | `host.ts` (around lines 954-1013), `SUPPORTED_INTERFACES` in `manifest.ts`                                                                                                                                                                                      |
| `model.stream`, `net.fetch`, `timer.sleep` for a guest                                                                                            | Missing in the production host | They exist only in `experiments/eve-guest-spike/host/ops.mjs` and `experiments/eve-host-boa/host/*`. `net.fetch` is refused on purpose (`isolation-verify.ts`).                                                                                                 |
| Durable store for the Eve guest's sessions                                                                                                        | Missing in the production host | It exists only as the experiment's `store.*` operations (`experiments/eve-host-boa/host/file-store.mjs`). Guests have `db.*` on declared collections, writable only from mutations.                                                                             |
| Host capabilities for agent execution (`runs@1`, `model@1`, `workspace@1`, `checks@1`)                                                            | Proposed                       | `docs/architecture/agent-execution-host-capabilities.md`                                                                                                                                                                                                        |
| Long-running or suspendable invocation; idle release or resume of a guest                                                                         | Missing                        | instances are reused only while warm; actions are capped (15 min)                                                                                                                                                                                               |
| Eve packaged as a `.app`                                                                                                                          | Missing                        | the experiments run under a test harness: no manifest, no producer                                                                                                                                                                                              |
| Guest cold start                                                                                                                                  | Partial                        | about 39 s to load and 567 MB of linear memory, against a 256 MiB default limit (`experiments/eve-host-boa/README.md`)                                                                                                                                          |
| Application principal per deployed app; two-party grants; revocation                                                                              | Verified                       | `docs/contracts/application-participation/01-application-principal.md`, `02-requirements-and-grants.md`; `apps/cloud-portal/test/application-principal.test.ts`, `participation.test.ts`                                                                        |
| Run-time `actingAs` identity for a guest's outbound calls                                                                                         | Partial                        | contract 02, "Not yet done"                                                                                                                                                                                                                                     |
| Deploy contract (upload, idempotent deployments, lifecycle, rollback)                                                                             | Off-path (local tests only)    | `docs/contracts/feltkit-deploy/CONTRACT.md`; `apps/cloud-portal/test/hosting-api.test.ts`; `packages/appboundry-agent`                                                                                                                                          |
| Secrets inside an artifact; managed capability bindings in a deployment                                                                           | Missing                        | contract §8; no provisioning code in `appboundry-agent` or `cloud-portal`                                                                                                                                                                                       |

### 1.3 FeltKit and the applications

| Capability                                                                                                               | Status                                                              | Evidence                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-application eve agents (`EveHost` spawns `eve start` per agent)                                                      | Verified, but **not the destination**                               | `packages/sdk/src/server/eve.ts`; `tests/e2e/agent-control-runtime.test.mjs`                                                                                                                                                                   |
| Remote executor (`EveRemoteExecutor { url, serviceKey }`, ES256 identity, `/_feltkit/eve/<agent>/key`, bridge `/invoke`) | Off-path (a scripted executor; one app and one agent)               | `packages/sdk/src/app.ts:248`, `eve.ts` `#connect`; `packages/sdk/test/eve-remote.test.ts`                                                                                                                                                     |
| Capability bridge with grant check on every call (`WorkersStore.check`: revoked or expired)                              | Verified for one app                                                | `eve.ts` `#bridge`, `runtime/workers.ts:308`; `workers.test.ts`                                                                                                                                                                                |
| "Issuer still holds what the grant covers", checked on each `/invoke`                                                    | Partial                                                             | checked only in `startDelegated`/`sendDelegated`                                                                                                                                                                                               |
| `feltkitSessionAccess()` and the signed `session` claim                                                                  | Off-path; no tests; needs an eve release with `SessionAccessPolicy` | `945ffdb`                                                                                                                                                                                                                                      |
| Multi-application connection to one Eve (per-app issuer keys or JWKS, per-app bridge routing)                            | Missing                                                             | `feltkitAuth()` accepts one issuer, one audience and one key                                                                                                                                                                                   |
| FeltKit app on the AppBoundry target using an agent                                                                      | Blocked (refused at build)                                          | `docs/APPBOUNDRY.md`, `ctx.agent`/`app.agent` rows                                                                                                                                                                                             |
| Organization concept spanning applications; app registry or discovery                                                    | Missing                                                             | tenancy is per app (`runtime/tenancy.ts`)                                                                                                                                                                                                      |
| Meetings ↔ Eve                                                                                                           | Partial                                                             | `meetings/feltkit/orgagents.ts` calls the `feltkit-eve` app through bespoke AppPort capabilities (`eve.meetings.join/notify/leave`); `tests/eve-participant.test.ts`. `feltkit-eve/app.ts` names "the AppBoundry .app" as the future executor. |

## 2. Dependency map

```
eve2   host interface ──► durable host store (this PR) ──► packaging producer (S6)
                                   │                               │
AppBoundry  sessions@1 (S2) ──► agent lifecycle + timers (S4) ──► Eve .app runs (S7) ──► deploy/ops (S10)
            model@1 (S3) ────────────┘                               │
            application connections + actingAs (S8) ─────────────────┤
FeltKit     organizational connection client (S9) ───────────────────┘
apps        Meetings + a second app on the organizational Eve (S11, final scenario)
```

Topic by topic:

1. **Organizational identity.** An AppBoundry application principal, owned by the organization. Verified as a platform capability; it is not yet applied to Eve (S7).
2. **`.app` packaging and manifest.** The format is verified. Eve is not packaged (S6), and the manifest cannot yet declare the interfaces Eve needs (S2-S4).
3. **Wasm guest execution.** The production host is verified. The interfaces Eve needs are missing (S2-S4), and cold start is over the memory limit (S5).
4. **Host interface.** Verified.
5. **Checkpoints and stream restore.** Verified in eve (#39). Production host storage is verified as `sessions@1` (S2, in review): Eve's restart scenarios pass on it, on Node and Boa, with the store in a real `ArtifactHost`. Eve itself does not yet run in the production host (S3, S4, S7).
6. **Conversation identity and isolation.** Verified in eve, by application channel and conversation token. It must be preserved end to end in the connection contract (S8, S9).
7. **Per-delivery authentication and authorization.**
   - eve carries `auth` on each delivery.
   - The authority to check it belongs to the connecting application and AppBoundry grants (S8, S9).
   - `sessionAccess` applies to eve's HTTP channel and has no counterpart on the host interface. That gap is decision D4.
8. **FeltKit organizational integration.** Per-app today. The organizational client is missing (S9).
9. **Context-provider contract.** No per-delivery context is pushed today (delivery message, attachments, capability tools). It is defined in S9 on the existing delivery fields; no new provider system.
10. **Capabilities and delegated authority.** The FeltKit bridge and AppBoundry grants are verified separately. Their composition is S8.
11. **On-demand execution and idle release.** Restore makes it possible (this PR). The host lifecycle is S4.
12. **Deployment, upgrades, configuration, operations.** Partial (S10).
13. **Real application experience.** Meetings is partial (S11).

## 3. Unresolved decisions

These need an owner's decision; each blocks the slice named.

- **D1 (blocks S4): the agent guest execution model in `appboundry-host`.**
  - Proposed: instantiate on a delivery, `restore` from the store, run to idle, then release the instance. Keep it warm for a bounded idle window.
  - The alternative is a resident instance per organization.
  - Approval waits become idle waits, which restore already supports.
- **D2 (blocks S2): where Eve's store lives.** Decided in S2.
  - Taken: a host-owned, guest-private store behind a new `sessions@1` interface. Its operations are the `EveHostStore` strings.
  - The alternative is collections declared in the manifest through `db.*`. That is writable only from mutations and exposes session internals to app code, so it is not recommended.
- **D3 (blocks S3): model access.**
  - Proposed: `model@1`. The host resolves the organization's configured models; a Resolver binding holds the credential; the guest never sees a key.
  - `docs/architecture/agent-execution-host-capabilities.md` already proposes `model@1`.
- **D4 (blocks S8, S9): the connection contract for applications.**
  - Proposed: one generic contract, `agent-connections@1`, with operations `deliver`, `answer`, `result`, `stream`. The caller is the AppBoundry application principal, the application name is derived from it, and the person's identity is carried as a signed assertion per delivery.
  - The alternative is bespoke capabilities per app, the current Meetings pattern. They don't scale and duplicate the contract.
  - Session access on this path is decided by the calling application's own records, as `feltkitSessionAccess()` does today.
- **D5 (later; does not block the first production version): restoring subagent child sessions, workflow-tool runs and timers.**
- **D6 (blocks S5): cold-start strategy.** Engine snapshot after load, bundle reduction, or a raised memory limit for agent guests.

## 4. Ordered implementation slices

Each slice is one PR in its owning repository unless stated otherwise. "Blocks" means the slice blocks the final `.app` goal.

**S1: Durable host sessions.** eve2. **Done in this PR.**

- Adds `EveHostStore` and restore.
- Tests: the restore integration suite, and Node and Boa SIGKILL tests.

**S2: `sessions@1`, a durable store for agent guests.** AppBoundry. Blocks.

- **Code areas:**
  - `packages/appboundry-host/src/manifest.ts`: add `sessions: [1]` to `SUPPORTED_INTERFACES`;
  - `host.ts` `#operate`: `sessions.appendLine`, `sessions.readLines`, `sessions.saveSession`, `sessions.readSessions`;
  - a host-owned FeltDB collection pair, not visible to `db.*`;
  - `docs/artifact-formats.md`.
- **Builds on:** the `EveHostStore` contract (S1) and the host's FeltDB.
- **Prerequisite:** decision D2.
- **Contract:** a new manifest interface, `sessions@1`.
- **Acceptance:**
  - a durable append resolves only after commit;
  - the line index must be the next one;
  - records are opaque strings;
  - per-application isolation of store contents;
  - the operations are refused unless declared.
- **Tests:** `appboundry-host/test/sessions-interface.test.ts`, using a probe guest. Restart persistence is checked by reopening the store in a new host process.
- **S2 status (AppBoundry PR in review; eve fix merged in #41).**
- **Implemented and verified:**
  - `sessions@1` in `appboundry-host` (`src/sessions.ts`), actions only, in the host's own FeltDB state: `_appboundry_agent_sessions` and `_appboundry_agent_session_lines`. Documented in `docs/artifact-runtime.md`.
  - Contract and failure tests (`test/sessions.test.ts`):
    - ordering;
    - `CONFLICT` for a repeated, out-of-order or concurrent append;
    - invalid input;
    - corrupt data as `DATA_LOSS`, never an empty restore;
    - uncommitted writes as `UNAVAILABLE`;
    - refusal when not declared or outside an action.
  - Isolation: two applications on one FeltDB, guest-supplied scope ignored, and `db.*` refused on both collections.
  - Process death (`test/sessions-restart.test.ts`): a SIGKILLed host, then a fresh host process reads every acknowledged line and record back in order, including after a kill mid-stream.
  - eve through `EveHostStore` (`experiments/eve-host-boa`): 12/12 SIGKILL scenarios on Node and Boa, each on the file store and on `sessions@1` in a real `ArtifactHost`:
    - history and conversation isolation;
    - approvals run once;
    - completed effects not repeated;
    - interrupted effects reported as uncertain and not retried.
  - eve's `idle()` and `dispose()` wait for store writes (#41). eve takes no FeltDB dependency.
- **Implemented, not verified against a remote FeltDB:**
  - the managed contract declares both collections, so the managed authority accepts them and managed backups include them (contract test only);
  - running `sessions@1` against a `feltdb-server` (`managed-acceptance.test.ts` with `FELTDB_REPO`) is a required test before S7.
- **Remaining limitations:**
  - durability beyond process death (for example power loss) is whatever the configured FeltDB promises;
  - the 10,000-session cap is enforced when sessions are read back with `sessions.readSessions`, not when they are written;
  - no session deletion or retention.
- **Later slices:**
  - eve does not yet run in the production host (S3 model access, S4 lifecycle and timers, S7);
  - backup, retention and operations of session state (S10).

**S3: `model@1`, host-resolved models.** AppBoundry. Blocks.

- **Code areas:** `manifest.ts`; `host.ts` (`model.stream`, wire format from `experiments/eve-guest-spike/guest/wire.js`); a Resolver binding through the capability bindings file.
- **Prerequisite:** decision D3.
- **Acceptance:** a guest streams a model response; the credential never enters guest memory (as in the eve-host-boa credential probe); calls are recorded in the outbound ledger.
- **Tests:** a scripted provider in unit tests; a real-provider test that skips without credentials.

**S4: agent guest lifecycle, timers and capability fetch.** AppBoundry. Blocks.

- **Code areas:**
  - `guest.ts` and `host.ts`: an `agent` invocation kind with delivery, idle detection and release, and restore on the next delivery;
  - `timer.sleep`;
  - routing of the capability endpoint to `capability.invoke` (the experiment's `capability-fetch.mjs` pattern).
- **Prerequisites:** S2, S3, decision D1.
- **Acceptance:**
  - an idle instance is released;
  - the next delivery restores the session from `sessions@1`;
  - a SIGKILLed host restores on restart;
  - approval waits survive release.
- **Tests:** a port of `experiments/eve-host-boa/test/restart.test.mjs` onto `appboundry-host`.

**S5: cold start within limits.** AppBoundry, with eve where the bundle is reduced. Blocks production.

- **Prerequisite:** decision D6.
- **Acceptance:** a cold start under a stated budget, and memory within an agent-guest limit, both measured.

**S6: Eve `.app` producer.** eve2 (a command or script) or AppBoundry tooling, decided in the PR.

- Builds `module.wasm` with its program section and `manifest.json` from `eve build`'s compiled agent (the `experiments/eve-host-boa/build.mjs` pipeline).
- **Prerequisites:** S2-S4, so the manifest can declare its interfaces.
- **Acceptance:** `appboundry verify` and `appboundry inspect` accept the artifact; there are no Node built-ins on its static graph.
- **Tests:** a producer test plus `artifact-host.test.ts`-style load.

**S7: Eve `.app` runs on `appboundry-host` as the organization's application.** AppBoundry experiments to tests.

- **Prerequisites:** S6, S5.
- **Acceptance:** the final scenario's steps 1-3 and 11-14, against the real artifact.

**S8: application connections and acting identity.** AppBoundry. Blocks.

- **Code areas:** `agent-connections@1` (decision D4) on the participation contracts; `actingAs` (contract 02).
- **Acceptance:**
  - two applications reach one Eve with separate conversations;
  - a revoked grant stops a connection;
  - a person's assertion is verified per delivery.

**S9: FeltKit organizational Eve client.** FeltKit. Blocks.

- Replace the per-app `EveHost` path, for an app that names an organizational Eve, with a client of `agent-connections@1`.
- Per-app keys (a JWKS by `kid`) instead of one env key.
- Context comes from the existing delivery fields.
- Check "issuer still holds the grant" on every `/invoke` (gap 1.3).
- Tests for `feltkitSessionAccess()`.
- **Prerequisites:** S8 and an eve release with rkendel1/eve2#37.

**S10: operations.** AppBoundry (and FeltKit where it surfaces state). Required for the first production version.

- Configuration and secrets supplied by bindings, never in the artifact.
- Upgrade and rollback of the Eve `.app`. A checkpoint version gate: restore refuses an unreadable checkpoint (S1) and the deploy refuses a downgrade across versions.
- Backup and restore of `sessions@1` contents.
- Surfacing refused restorations and uncertain effects.
- Usage and lifecycle observability.

**S11: Meetings and a second FeltKit app on the organizational Eve.** meetings, feltkit-eve, FeltKit. The final scenario.

**Later, not blocking:** D5 (child sessions, workflow-tool runs, timers durable); deliveries accepted mid-turn made durable through the inbox `keep` hook (`execution/in-process/inbox-transport.ts`); proactive work; organization-wide administration UI.

## 5. Status

| Slice                                        | Repository                     | Status           | PR      |
| -------------------------------------------- | ------------------------------ | ---------------- | ------- |
| S1 Durable host sessions                     | eve2                           | Done             | #39     |
| S2 `sessions@1`                              | appboundry                     | Done (in review) | eve #41 |
| S3 `model@1`                                 | appboundry                     | Not started (D3) |         |
| S4 Agent lifecycle, timers, capability fetch | appboundry                     | Not started (D1) |         |
| S5 Cold start                                | appboundry / eve2              | Not started (D6) |         |
| S6 `.app` producer                           | eve2 or appboundry             | Not started      |         |
| S7 Eve `.app` on `appboundry-host`           | appboundry                     | Not started      |         |
| S8 Application connections, `actingAs`       | appboundry                     | Not started (D4) |         |
| S9 FeltKit organizational client             | feltkit                        | Not started      |         |
| S10 Operations                               | appboundry, feltkit            | Not started      |         |
| S11 Real applications                        | meetings, feltkit-eve, feltkit | Not started      |         |

## 6. Final acceptance scenario

These steps run against the real artifact. **A** means automatable in `appboundry-host` tests; **D** means a deployment-level demonstration.

1. The organization has one Eve application principal. (A)
2. Eve is built as `module.wasm` plus a valid `appboundry.app/1` manifest, and `appboundry verify` passes. (A)
3. `appboundry-host` loads and runs it. (A; deployed: D)
4. Two FeltKit applications connect through `agent-connections@1`. (A with fixture apps; D with Meetings and a second app)
5. Each supplies its own context and authorized capabilities. (A)
6. Conversation continuity holds per application and conversation. (A)
7. No context or history crosses connections, including by session ID. (A)
8. A person's identity and delegated authority are checked on each delivery. (A)
9. A revoked person or grant cannot continue with a previously valid session identifier. (A)
10. Eve performs an authorized capability operation, recorded in the outbound ledger. (A)
11. The host is SIGKILLed and restarted. (A)
12. Eve restores and resumes the right conversation (`EveHost.restoration`). (A)
13. An interrupted effect is not repeated, and the model is told. (A)
14. An idle instance is released; its identity and state remain. (A, with resource measurement)
15. An application reconnects without provisioning another Eve. (A)

## 7. Operational readiness

**First production version:**

- **Provisioning and administration:** the organization deploys one Eve `.app` through the deploy contract.
- **Configuration and secrets:** models and secrets come through bindings (S3, S10), never in the artifact.
- **Connecting applications:** applications connect by grant (S8).
- **Context and capabilities:** applications declare capabilities through AppPort requirements and offers. Context travels per delivery (S9).
- **Authority:** revocation is through AppBoundry grants and FeltKit grants, checked per call.
- **Backup:** `sessions@1` contents are backed up with the host's FeltDB (S10).
- **Upgrades:** go through the deploy contract with a checkpoint-compatibility gate.
- **Surfacing problems:** refused restorations, uncertain effects (reported to the model and recorded as call facts) and resource usage are surfaced to operators.
- **No per-application processes:** there is no Eve process per application.

**Later:**

- organization-wide administration UI;
- multi-host execution;
- proactive or scheduled work.

## 8. Next implementation prompt (S2)

> **Repository:** `rkendel1/appboundry` (work on the session branch; open a PR; do not merge).
>
> **Objective.** Add a `sessions@1` host interface to `appboundry-host` that gives an agent guest durable, private
> session storage. Its operations are exactly the `EveHostStore` contract that `eve/experimental/host` consumes:
>
> - `sessions.appendLine(sessionId, index, line)`: rejects an index that is not the next one, and resolves only after
>   commit;
> - `sessions.readLines(sessionId)`;
> - `sessions.saveSession(sessionId, record)`: replaces the record, and resolves only after commit;
> - `sessions.readSessions()`.
>
> **Prerequisites.**
>
> - rkendel1/eve2 (the PR adding `research/organizational-eve-roadmap.md`) is merged.
> - Decision D2 is confirmed: a host-owned store, private to the application and not exposed through `db.*`.
>
> **Grounding.** Read the following before writing code:
>
> - the roadmap §1.2, §3 D2 and §4 S2;
> - `packages/appboundry-host/src/manifest.ts` (`SUPPORTED_INTERFACES`, `parseManifest`);
> - `host.ts` `#operate`;
> - `collections.ts`;
> - `experiments/eve-host-boa/host/file-store.mjs` (the reference implementation and its `store.*` operation shapes);
> - `test/restart.test.mjs`.
>
> **Acceptance.**
>
> 1. A manifest may declare `sessions: 1`. An undeclared guest calling `sessions.*` is refused with a clear error.
> 2. Storage is host-owned FeltDB, keyed by application. A second application cannot read or write the first's
>    sessions.
> 3. Each write is durable before the operation resolves. A new host process on the same state reads back exactly
>    what was written.
> 4. An out-of-order `appendLine` is refused and changes nothing.
> 5. `docs/artifact-formats.md` documents the interface.
> 6. A probe-guest test covers 1-4. A restart test runs the eve-host-boa guest's restart scenarios against
>    `sessions.*` served by `appboundry-host` instead of the experiment's file store. If the guest cannot yet run
>    under `appboundry-host` because S3/S4 are missing, run those scenarios through the experiment harness with the
>    new store implementation, and say so.
>
> **Non-goals.** `model@1`, timers, the agent lifecycle, packaging Eve as a `.app`, FeltKit changes, any change to
> eve's `EveHostStore` contract.
>
> **Report.** What is verified on `appboundry-host` versus the experiment harness; exact test results; anything in the
> contract that needed to change, with evidence.

---
issue: "none: provider-neutral execution (architecture slice before context slice 3)"
status: in-progress
last_updated: "2026-11-27"
---

# Provider-neutral execution

Goal: eve owns what execution means. An execution host implements how it is carried out. Vercel Workflow is one host, not eve's definition of execution.

This document records the audit of eve2 main `2db2163`, the contracts that already exist, what this slice changed, and the verified gaps. It defines no new orchestration abstraction.

## Finding: the boundary already exists

eve already separates its execution semantics from Workflow. The separation runs through five contracts:

| Contract                                        | Location                                                    | Owns                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionHost`, `SessionTurnHost`                | `execution/session/program.ts`, `execution/session/turn.ts` | how a turn step runs (`runTurnStep`, `dispatchRuns`, `applyRunMessages`), waiting (`until`), checkpoints (`persistence`), moves, tool stubs |
| `SessionInboxHandle`                            | `execution/session-inbox/inbox.ts`                          | deliveries, interrupts, handovers into a running session                                                                                    |
| `DurableHost`, `HostedRoute`, the host registry | `execution/hosts.ts`                                        | delivery to a session or hook, run status, cancellation, line store, callback base URL, step attempt                                        |
| `SessionCheckpointSink`, `DurableSessionStore`  | `execution/in-process/session-store.ts`                     | durable session records and event lines, provider-neutral JSON                                                                              |
| `Runtime`                                       | `channel/types.ts`                                          | sessions, commands and streams, as channels and hosts see them                                                                              |

Two independent implementations exist:

- **Workflow:** `execution/session/workflow-host.ts`, `execution/workflow-host/*`, `execution/session-inbox/{workflow-transport,resume,owner}.ts`, `execution/workflow-runtime.ts`.
- **In-process:** `execution/in-process/*`, with an optional `DurableSessionStore`. `eve/experimental/host` exposes it, and the AppBoundry `.app` uses it with `sessions@1` as the store.

Rule 66 already forbade the core files from importing Workflow directly.

Measured by walking the static value-import graph, none of these reaches a Workflow SDK or adapter module: the in-process runtime, `eve/experimental/host`, the session program and the harness kernel. They reach 662, 663, 523 and 451 modules respectively. `execution/workflow-runtime.ts` was the control and reaches 9. Workflow enters only through lazy `import()`.

## Coupling map and classification

| Dependency                                                                        | Location                                                                                                       | Class                                                      | This slice                                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A Workflow route-path constant imported by the host inventory                     | `framework/host-inventory.ts` → `internal/workflow-bundle/flow-route.ts`                                       | accidental coupling                                        | moved to `protocol/routes.ts`; the bundle re-exports it                                                     |
| External callbacks resumed through Workflow directly, bypassing the host registry | `execution/connections/callback-route.ts`, `subagents/callback-route.ts` → `session-inbox/owner.ts`            | accidental coupling                                        | new `resumeRoutedCallback` and `{ callback }` address; Workflow implements it with its runnable-owner check |
| A refusal that names "a deployment" as the only alternative                       | `execution/in-process/host.ts`                                                                                 | accidental coupling (wording)                              | names the missing capability                                                                                |
| Workflow's webhook and stub-inspection routes in eve's HTTP channel               | `eve-channel/index.ts`                                                                                         | execution-provider implementation, mounted unconditionally | unchanged; they load Workflow lazily                                                                        |
| Error serialization, callback URLs, workflow references and registry              | `execution/workflow-{errors,callback-url,references,registry}.ts`                                              | core semantics with Workflow names; none imports the SDK   | unchanged; renaming is cosmetic                                                                             |
| Schedules                                                                         | `runtime/schedules/durable/*`, `internal/nitro/routes/schedule-*`                                              | execution-provider implementation, Workflow only           | gap                                                                                                         |
| Connection event owners                                                           | `runtime/connections/events/*`, via `DurableHost.connectionEvents`                                             | execution-provider implementation, Workflow only           | gap                                                                                                         |
| Remote agents, and tools that start, send to or read another session              | `execution/agent-sessions/steps.ts`; `execution/in-process/host.ts` (`NO_STEP_RUNTIME`, `recordRemoteBinding`) | eve semantics that only Workflow implements                | gap                                                                                                         |
| Compaction and prewarm handoff (`moves`), version stamps, external cancel         | `execution/session/handoff*.ts`, `timeout-*.ts`                                                                | provider mechanics; in-process retains the session instead | not needed in-process                                                                                       |
| Durable timers inside workflow-tool runs                                          | `execution/tools/workflow/*`                                                                                   | provider mechanics, Workflow only (decision D5)            | gap, now declared                                                                                           |
| `VERCEL_*` and `WORKFLOW_*` environment                                           | tracing, instrumentation, `internal/nitro`, `execution/install-workflow-deployment-id.ts`                      | provider configuration and telemetry                       | unchanged                                                                                                   |
| Model providers                                                                   | `harness/model-call/*`, `model@1` on AppBoundry                                                                | model provider, already separate                           | unchanged                                                                                                   |
| Capabilities and authority                                                        | AppPort, AuthBoundry, AppBoundry `connections@1`                                                               | capability layer, already separate                         | unchanged                                                                                                   |

## Changes in this slice

- **Rule 69 (`pnpm guard:invariants`).** The static value-import closure of the four neutral entries must reach no Workflow module at any depth. Its first run found the host-inventory edge above. A planted import in `execution/workflow-errors.ts` is reported with its chain (`program.ts → turn.ts → workflow-errors.ts`).
- **`resumeRoutedCallback(token, payload)` and `DeliveryAddress { callback }`.** These carry eve's rule that an external callback resumes only a live owner:
  - A hosted session gets it first.
  - The installed durable host gets it otherwise. Workflow implements it with `resumeRunnableHook`, exactly as before; in-process, with its routed delivery.
  - Without a host, it is `HookNotFoundError`, answered 404 and never a silent fallback.
- **A third battery host.** `internal/testing/session-host/` runs one lifecycle battery against every host, skipping only cases a host declares it cannot support. It now also runs against the in-process host with a durable store (`in-process-durable`), the configuration AppBoundry runs.
- **A declared timer gap.** A new `durableTimers` capability separates "sessions survive process death" from "a timer inside a workflow-tool run is re-armed after it", which the durable in-process host does not do.

## Verification

### Session-host battery (15 cases per host)

| Case                                                                    | in-process       | in-process + store      | Workflow (local world) |
| ----------------------------------------------------------------------- | ---------------- | ----------------------- | ---------------------- |
| delivery, stream order, new address, unknown session, refused hooks (4) | pass             | pass                    | pass                   |
| agent-tool child session and its reply                                  | pass             | pass                    | pass                   |
| lost step completion, retry limits, write failures, task start once (4) | pass             | pass                    | pass                   |
| model call running at process death (spec 8, 9)                         | skip (`durable`) | pass                    | pass                   |
| lost timer re-armed after restart                                       | skip             | skip (`durableTimers`)  | pass                   |
| run owned by another eve version                                        | skip             | skip (`stamps`)         | pass                   |
| run cancelled outside eve                                               | skip             | skip (`externalCancel`) | pass                   |
| failure after a compaction handoff                                      | skip             | skip (`moves`)          | pass                   |

Totals: 35 passed and 10 skipped by declared capability; none failed.

### Other evidence

- The in-process versus Workflow parity suite passes: sessions, approvals, compaction and clear, cancel.
- The callback-route tests pass, with the Workflow host installed and with hosted sessions.
- AppBoundry: the `eve-appboundry` suites run eve on real `appboundry-host` processes with `sessions@1` on FeltDB. They cover delivery, multiple turns, independent concurrent sessions, compaction with the full transcript, `SIGKILL` and restore, uncertain capability outcomes not retried, idle release, connection and session isolation, AuthBoundry-delegated capability calls, and ledger evidence.

### Provider overhead

These are the same eve work with a mock model on one machine, in wall-clock milliseconds: the providers' mechanics, not production cost.

| Case                                  | in-process | in-process + store | Workflow (local world) |
| ------------------------------------- | ---------- | ------------------ | ---------------------- |
| one delivery, stream to its tail      | 326        | 379                | 991                    |
| agent-tool child session              | 140        | 140                | 365                    |
| every write fails, the next turn runs | 59         | 62                 | 3,188                  |
| recover a turn whose model call died  | n/a        | ~55                | ~1,150                 |

The local world runs Workflow's queue, step persistence and replay in process. Vercel's hosted Workflow adds network and per-step persistence, not measured here.

## Can AppBoundry run the complete eve lifecycle?

Not yet, and this slice does not claim it.

Verified on AppBoundry: delivery, turns, concurrency, isolation, checkpoints, process death and restore, compaction, cancellation of in-flight work, uncertain outcomes, and delegated capability calls.

Missing, by declared gaps:

- remote agents, and tools that act on other sessions (`NO_STEP_RUNTIME`);
- schedules;
- connection event owners;
- durable timers inside workflow-tool runs (D5);
- version stamps;
- external cancel.

Local subagents run in the in-process host, but AppBoundry's lane-scoped `sessions@1` lets an instance write only its own lane's session. Persisting a child session there needs a host decision.

## What another execution host needs

1. Implement `SessionHost` for turn steps, waiting and checkpoints.
2. Implement `SessionInboxHandle` for deliveries.
3. Register as `DurableHost` or `HostedRoute` for delivery, status, cancel, line store and callbacks.
4. Supply a `DurableSessionStore` for durability.
5. Declare its `HostCapabilities` and pass the battery for every capability it claims.

Model access and capability authority stay separate: `model@1` and AppPort with AuthBoundry.

## Decisions left open

1. **Cross-session operations off Workflow.** Should the in-process host serve tools that start, send to or read other sessions through its own `Runtime`, replacing `NO_STEP_RUNTIME`? On AppBoundry this needs `sessions@1` permission for child sessions.
2. **Schedules and connection events.** These run only on Workflow. Is there a host-neutral port for them, or does each host provide them?
3. **D5.** Should timers and workflow-tool runs survive process death on hosts other than Workflow?
4. **Workflow-only routes.** Should eve's HTTP channel mount Workflow's webhook and stub routes only when Workflow is the installed host?

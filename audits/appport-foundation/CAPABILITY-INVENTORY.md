# Capability inventory: Boundry agents and Personal OS

This is Phase 1 of the Capability Consolidation milestone: an inventory only. Nothing was ported, and no source repository was modified.

**Destination:** `examples/appport-agent/` on `claude/dreamy-galileo-4z03p5`, together with the platform it builds on: eve, AppPort, AuthBoundry, FeltDB, AppPort Services, Resolver and FeltKit.

Every entry points to source code. The per-source evidence, with file:line, contracts, dependencies, authorization, effect, tests and status for each entry, is in `capability-inventory/`:

| Appendix                                                            | Source                                            |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| [`stack-agent.md`](capability-inventory/stack-agent.md)             | Stack-Agent, plus the chip-rs and 3fx lineage     |
| [`secret-agent.md`](capability-inventory/secret-agent.md)           | Secret-Agent (`appport-agent`)                    |
| [`personalos.md`](capability-inventory/personalos.md)               | Personal OS, including AnywhereAide               |
| [`other-agents.md`](capability-inventory/other-agents.md)           | 20 other repositories                             |
| [`platform-baseline.md`](capability-inventory/platform-baseline.md) | What the destination and platform already provide |

## Sources inspected

| Source                                                                                                                                                                                                                                                          | Commit          | Depth                                                                                                                                   | Tests run                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `rkendel1/stack-agent`                                                                                                                                                                                                                                          | `c066006`       | Every capability provider, entry point and crate. The largest modules (`software_work.rs`, `service.rs`) were read at module level only | No: crates are not cached offline |
| `rkendel1/chip-rs`                                                                                                                                                                                                                                              | `c14522a`       | Lineage only (provenance doc and crate diff)                                                                                            | —                                 |
| `rkendel1/3fx`                                                                                                                                                                                                                                                  | `2d5151e`       | Classified, not inventoried (about 753k lines of Zig)                                                                                   | —                                 |
| `rkendel1/secret-agent`                                                                                                                                                                                                                                         | `20a451b`       | Every command, native tool and core module. `strategy.rs`, the arms oracle and fixtures were read in outline                            | No: crates are not cached offline |
| `rkendel1/personalOS`, incl. AnywhereAide                                                                                                                                                                                                                       | `c684688`       | Every FeltKit function, integration, job and surface client. UI rendering and e2e scripts by name only                                  | No: `node_modules` absent         |
| `rkendel1/feltkit`                                                                                                                                                                                                                                              | `04d307f`       | Capability publishing and platform services                                                                                             | —                                 |
| `rkendel1/appboundry`                                                                                                                                                                                                                                           | `9f84020`       | Agent work, MCP projection and the host agent                                                                                           | —                                 |
| 19 more repos: voice-agent, desktop-agents, atomic-agent, ai-office, browser-agent-runtime, TaskFlow, frame, multiplayer, saaskit, signal, competition, relationship-agent, resolver-control, boundry, boundry-intel, boundry-maint, boundry-mesh, llm, overlay | Shallow, latest | Triage of all 19; capability inventory of agent repos and agent-reachable surfaces                                                      | —                                 |
| Platform: `eve2`, `appport` (`a6c2c61`), `appport-services` (`c81d7d4`), `resolver` (`aaab053`), `resolver-control`, `flow_db` (`0f5049e`), `@authboundry/local` 0.1.1                                                                                          | —               | Built-in tools, capabilities, services                                                                                                  | —                                 |

**AnywhereAide** is not a separate repository. It is Personal OS's "Anywhere" surface:

- the `@anywhereaide` X bot (`personalOS/feltkit/xsurface.ts`, `_x.ts`);
- the interaction and invocation contracts (`interactions.ts`, `invocations.ts`, `docs/ANYWHERE.md`);
- the Chrome and iOS clients (`extension/`, `ios/`).

It is inventoried in the Personal OS appendix and marked AA.

**Not inspected:**

- **Other repositories.** The `rkendel1` account has more than 200; only the repositories above were inspected, chosen as the Boundry platform and product repositories pushed recently plus every agent-like name. No completeness is claimed for the rest.
- **Services not available here:** PAX, cli2, Compute, the AuthBoundry server internals (Rust) and AppPort Services Intelligence.

## Evidence conventions

| Label      | Meaning                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tested`   | Tests exist that exercise the behavior, identified by reading them. **No source test suite was run:** the Rust crates are not cached offline, and the TypeScript repos have no installed dependencies. |
| `doc-only` | Only documentation claims it                                                                                                                                                                           |
| `untested` | No test found                                                                                                                                                                                          |

The per-source analyses were done in parallel. I then checked the claims that decide classifications directly against source:

| Claim                                                                                                     | Where verified                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack-Agent gives the model no shell, process, network or git-mutation capability                         | `crates/stack-agent/tests/capability_surface.rs:134`                                                                                                                                                                                      |
| Stack-Agent's `detect_stuck`, `settle`, `withheld`/`protected` and `check_pins`                           | `stuck.rs:72`, `chip-agent-state/src/lib.rs:1737`, `policy.rs:196,267`, `host_capabilities/appport.rs:215`                                                                                                                                |
| Personal OS publishes 13 FeltKit functions as AppPort capabilities                                        | FeltKit `runtime/runtime.ts:605-610` publishes every function declaring `capability` and every integration operation not `expose: false`. The 13 declarations are in `personalOS/feltkit/*.ts`, and the model's tool list is `turn.ts:28` |
| FeltKit publishes mutations as consequential and idempotent, backed by a durable FeltDB idempotency store | FeltKit `runtime/capabilities.ts:37-42`, `runtime/idempotency.ts`                                                                                                                                                                         |
| AppPort already provides the contract analysis Secret-Agent reimplements                                  | `@appport/protocol` `compareManifests` (`compatibility.ts:436`); `@appport/integration` `deriveGraph` (`graph.ts:157`) and `assessReplacement` (`readiness.ts:198`)                                                                       |
| eve's default tools                                                                                       | `bash`, `read_file`, `write_file`, `edit_file`, `web_fetch`, `web_search` (`packages/eve/src/framework/sources/default-tools.ts:7-13`)                                                                                                    |

## Totals

Each row counts distinct user-visible operations or mechanisms. Helpers and duplicate registrations are excluded.

| Source                                                                              |   Total | Already available | Direct port | Contract adaptation | Integration required | Internal only | Duplicate | Retire | Unresolved |
| ----------------------------------------------------------------------------------- | ------: | ----------------: | ----------: | ------------------: | -------------------: | ------------: | --------: | -----: | ---------: |
| Stack-Agent                                                                         |      48 |                14 |           1 |                   5 |                    0 |             1 |        11 |     15 |          1 |
| Secret-Agent                                                                        |      28 |                 4 |           0 |                   1 |                    1 |            10 |         7 |      5 |          0 |
| Personal OS (11 of them AnywhereAide)                                               |      47 |                 2 |           0 |                  16 |                    5 |            17 |         6 |      1 |          0 |
| Other agents (voice-agent, Foundry, atomic-agent, ai-office, browser-agent-runtime) |      54 |                16 |           0 |                   8 |                   11 |             5 |         7 |      2 |          5 |
| Agent-reachable surfaces of product and platform apps                               |      16 |                13 |           0 |                   0 |                    0 |             1 |         0 |      0 |          2 |
| **All**                                                                             | **193** |            **49** |       **1** |              **30** |               **17** |        **34** |    **31** | **23** |      **8** |

Whole repositories classified, not itemized:

| Repository   | Classification        | Reason                                                                     |
| ------------ | --------------------- | -------------------------------------------------------------------------- |
| chip-rs      | Retire                | Superseded: Stack-Agent's provenance doc pins `c14522a` as its copy source |
| 3fx          | Retire / Duplicate    | Zig fx coding agent whose tools are eve built-ins                          |
| boundry-mesh | Platform, design only | "Nothing is built yet"                                                     |
| overlay      | Empty                 | No tracked files                                                           |
| llm          | Duplicate             | A model router; eve owns model configuration                               |

## What the destination and platform already provide

Full tables are in [`platform-baseline.md`](capability-inventory/platform-baseline.md).

**eve.** These are the inputs to "Already available" and "Duplicate" decisions.

| Area             | What it provides                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default tools    | `bash`, `read_file`, `write_file`, `edit_file`, `web_fetch`, `web_search` (supported models only), plus `agent` (subagents)                                                                                                            |
| Opt-in tools     | `glob`, `grep`, `ask_question`, `no_reply`, `sleep`, `workflow`, memory slot tools                                                                                                                                                     |
| Always available | `eve__search`, `eve__tool`, `eve__skill`, `eve__task_*`, `eve__reply`                                                                                                                                                                  |
| Framework        | Durable sessions and recovery, hooks, approvals, schedules (dynamic schedules are experimental), channels, MCP and OpenAPI connections, skills, memory providers, OpenTelemetry, evals, `eve/extensions/git` and `eve/extensions/code` |

The destination agent sets `defaultTools: false`.

**Destination agent.**

- **Tools:** `appport_capabilities`, `appport_contract`, `appport_invoke`.
- **Capabilities:** `catalog.lookup`, `catalog.reserve`, `catalog.reservation`.
- **Machinery:** AuthBoundry delegation, FeltDB work records and recovery, the operation ledger with idempotency and indeterminate handling, a FeltDB AppPort idempotency store, and Stack-Agent's reconciliation `decide`.

**AppPort.** `appport.manifest` and `appport.ping`; optional feedback capabilities; contract tooling as libraries:

- `contract-builder`: validate, diff and compatibility;
- `integration`: graph, lint, plan and readiness;
- `mcp`: bridge;
- `generators`.

None of the contract tooling is an agent tool.

**AppPort Services.** 11 service areas and 47 capability names (jobs, schedules, files, notifications, credentials, secrets and others). They are served through the service's own gateway and REST routes, **not as AppPort capabilities**.

**Resolver.** 23 AppPort capabilities behind one `resolver.call` permission, with Resolver's own grants. **Resolver Control** has 31.

**FeltKit.** It publishes app functions and integration operations as AppPort capabilities at `/appport` and as MCP tools at `/mcp`:

- mutations are idempotent, through a FeltDB-backed store;
- `ctx.authority.decide` checks AuthBoundry delegation;
- platform services include jobs, schedules, files, notifications, webhooks, intelligence, credential custody and agent tasks.

**FeltDB (all experimental).** Agent state (tasks, checkpoints, memory with provenance, handoffs), Durable Work (server runtime only), content store and agent executions.

**What the platform does not cover:**

- **Personal data:** no mailbox reading and no calendar anywhere; no model-facing todo tool in eve.
- **Messaging:** no X channel.
- **Research:** no citation-tracking research store.
- **Memory provenance:** eve's file memory has no provenance.
- **Contract safety:** no contract pinning.
- **Loop protection:** no loop or stuck guard.
- **Completion:** no completion gate over recorded outcomes.
- **Uncertain operations:** no operator resolution of indeterminate operations.
- **Delegation:** no cross-channel identity linking in eve, and no on-behalf-of identity on FeltKit's `/appport`.

## Destination decisions by source

IDs refer to the appendices, which hold the file:line evidence for every row.

### Stack-Agent (48)

| Decision                | IDs                                         | What they are                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Already available (14)  | SA-01–06, 11, 12, 21, 23, 28, 34, 43, 44    | `project.list/search/read/write`, read-only git views, `pax.test` → eve file tools and `bash`. Operator `exec` capabilities → eve `defineTool`. AppPort discovery and invoke → `appport_*`. `decide` → already ported. Token report, model providers, confinement, OpenTelemetry, limits and cancellation → eve |
| Direct port (1)         | SA-30                                       | **Deterministic stuck guard** (`chip-core/src/stuck.rs`), as an eve hook                                                                                                                                                                                                                                        |
| Contract adaptation (5) | SA-13, 20, 32, 33, 38                       | Contract-digest pinning, **operator settlement** of outcome-unknown intents, read-only goal-kind gating, credential and host-state path policy, ActionsSucceeded completion gate. All eve-internal; none becomes a model-facing AppPort capability                                                              |
| Internal only (1)       | SA-35                                       | Keyed local-write journal and project lock                                                                                                                                                                                                                                                                      |
| Duplicate (11)          | SA-14, 15, 17–19, 26, 31, 36, 39–41         | Capability authorization lists, the `work`/`serve`/tenancy/state CLIs, the remote-execution backend, capability-set composition, FeltDB durable agent state, the JSON decision protocol, context assembly, learning and episodic memory                                                                         |
| Retire (15)             | SA-07–10, 16, 22, 24, 25, 27, 29, 37, 45–48 | PAX observe, cli2, Compute, `verify`, `doctor`, the Rust architecture graph, experiments and self-tests, local and Wasm decision models, coding-specific verification gates, and unused crates (`chip-session`/`chip-turns`, Wasm host, `chip-appport-source`, `chip-symbol-loop`)                              |
| Unresolved (1)          | SA-42                                       | Workflow candidates mined from verified episodes: no destination use case established                                                                                                                                                                                                                           |

### Secret-Agent (28)

| Decision                 | IDs               | What they are                                                                                                                                                                                             |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Already available (4)    | SE-03, 05, 06, 09 | Native `list_capabilities`, `read`, observation `invoke`, model clients                                                                                                                                   |
| Contract adaptation (1)  | SE-08             | Goal checks (fail before the change, pass after). AppPort's replacement-scenario format can only assert sameness                                                                                          |
| Integration required (1) | SE-01             | **Contract-verified capability-implementation replacement**: plan, ask the model only for the implementation, run the app before and after, roll back on failure. An eve-internal workflow in the sandbox |
| Internal only (10)       | SE-02, 07, 20–27  | Dry-run planner and the replacement loop's internals: project scan, planner, input synthesis, verification judge, IPC host, evidence collection, bounded apply and rollback, run safety                   |
| Duplicate (7)            | SE-04, 13, 15–19  | `inspect`, the generic coding loop, and the Rust contract model, validation, rules and digest, graph and replacement boundary (all in `@appport/protocol` and `@appport/integration`)                     |
| Retire (5)               | SE-10–12, 14, 28  | Free-gateway preflight, eval and experiment harnesses, the fixture drift generator                                                                                                                        |

### Personal OS, including AnywhereAide (47)

| Decision                         | IDs                                                 | What they are                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Already available (2)            | PO-33, 34                                           | Web search integrations (eve `web_search`); delegation grants (AuthBoundry). Grants must never be agent-callable                                                                                                                                                                              |
| Contract adaptation (16)         | PO-06–11, 13, 14, 16–18, 20, 25, 30–32              | **Tasks and reminders** (list, create, update, complete, reopen, delete), **memory** (list, add, forget), **projects** (list, create), **documents** (list), **daily briefing**, **research** (start, read, cancel and retry). Seven of the 13 already published capabilities are in this set |
| Integration required (5, all AA) | PO-35, 41, 42, 43, 45                               | Identity linking through Resolver; the `@anywhereaide` X intake, reply and publish; the Chrome and iOS surface clients                                                                                                                                                                        |
| Internal only (17)               | PO-05, 12, 15, 19, 21–24, 26–29, 37, 39, 44, 46, 47 | Continuity view, reminder firing job, memory confirmation, project update, document upload and links, action log, approvals (human only), check-in and weekly jobs, inbox, settings, interaction and X views, Resolver integrations (refused to every role), webhooks                         |
| Duplicate (6)                    | PO-01, 02, 03, 36, 38, 40                           | Rules-based chat, the model turn engine, conversation transcripts, surface interactions and invocations and their receipts (eve channels plus `POST /work`)                                                                                                                                   |
| Retire (1)                       | PO-04                                               | Conversation rename and remove (no caller)                                                                                                                                                                                                                                                    |

### Other agents and surfaces (70)

| Decision                  | IDs                                                                                                 | What they are                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Already available (29)    | Foundry 07, 09–13; atomic-agent 01, 02, 04–06, 08, 10–12, 15; product surfaces OA-prod-01–05, 08–15 | File, shell, git, web, browser, memory, schedules, MCP, skills, Telegram. AppPort capabilities already published by TaskFlow, frame, multiplayer, relationship-agent, signal, competition, boundry-intel, boundry-maint, resolver-control and saaskit. AppBoundry's delegated durable work |
| Contract adaptation (8)   | voice 03–08, 10; Foundry 14                                                                         | **voice-agent tools** (contact lookup, business info, availability, booking, follow-ups, SMS, history), already published but bound to a runtime principal rather than delegation. **Structured evidence check** (Foundry, AGPL: re-implement, do not copy)                                |
| Integration required (11) | voice 02, 09; Foundry 01–03, 15, 16; ai-office 01–04                                                | Realtime phone voice and transfer; Foundry coding sessions, approvals and projects (needs a network path and AuthBoundry); IMAP email; WeChat and Feishu; Office host tools (outside the ecosystem)                                                                                        |
| Internal only (6)         | voice 11, 13; atomic 14, 16; office 05; OA-prod-16                                                  | Missed-call automation, operator surfaces, desktop OS controls, loop terminals, planner, AppBoundry deployment reconciler                                                                                                                                                                  |
| Duplicate (7)             | voice 01, 12; Foundry 08; atomic 07, 09; office 06, 07                                              | Model loop, per-call invocation ledger (duplicates the operation ledger), local computer use, raw HTTP, memory, local inference, approval policy                                                                                                                                           |
| Retire (2)                | browser-agent-runtime 01, 02                                                                        | WebLLM research tools                                                                                                                                                                                                                                                                      |
| Unresolved (8)            | Foundry 04–06; atomic 03, 13; OA-prod-06, 07                                                        | Compute environments, Compute CI and PAX inspection (ownership unknown); document extraction (would add runtime dependencies); vision (multimodal support not verified); saaskit reserve/commit/release and per-agent spending authority (overlap with `catalog.reserve`)                  |

## Internal mechanisms to preserve without exposing

These exist in the sources and are worth keeping as **runtime mechanisms**, never as model-callable tools:

| Mechanism                                                                                                                                   | Source                                                        | Destination home                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Deterministic stuck guard                                                                                                                   | stack-agent `chip-core/src/stuck.rs`                          | eve hook on `call.settled` → `ctx.cancel("stuck: …")`                                  |
| ActionsSucceeded completion gate                                                                                                            | stack-agent `host_capabilities/mod.rs:499`                    | Check in the destination's work completion over ledger outcomes                        |
| AppPort contract-digest pinning and pre-call re-check                                                                                       | stack-agent `host_capabilities/appport.rs:215`, `digest.rs`   | Guard in `appport_invoke` for consequential capabilities                               |
| Operator settlement (write-once, attested)                                                                                                  | stack-agent `chip-agent-state/src/lib.rs:1737`                | Operator-only route on the destination ledger                                          |
| Credential and host-state path policy                                                                                                       | stack-agent `chip-project/src/policy.rs`                      | eve file-tool wrappers. Only relevant where file tools are enabled; `bash` bypasses it |
| Ops kernel: `actingFor`, verified read-back, approval proposals                                                                             | personalOS `feltkit/_ops.ts`                                  | Stays in Personal OS; it is how delegated capabilities execute                         |
| Interaction and invocation invariants: content is data, never instructions; shared-audience privacy; per-step authority; once-only delivery | personalOS `interactions.ts`, `invocations.ts` tests          | Carried over as destination tests                                                      |
| Research pipeline and safe page reader                                                                                                      | personalOS `research.ts:175`, `researchstate.ts`, `_pages.ts` | Stays in Personal OS behind a research capability                                      |
| Replacement-loop internals                                                                                                                  | secret-agent SE-20–27                                         | Only if SE-01 is adopted                                                               |

## Duplication found in the destination itself

1. **The example host's idempotency store.** `examples/appport-agent/appport-host/idempotency-store.mjs` (the previous milestone) duplicates FeltKit's FeltDB-backed AppPort idempotency store (`feltkit/packages/sdk/src/runtime/idempotency.ts`). The example host is a stand-in application; real capability hosts are FeltKit apps, which already have the durable store. **Decision:** keep the example store only as the example host's implementation; do not grow it into a shared component.
2. **Per-call invocation ledgers.** voice-agent's ledger (OA-voice-12) and Personal OS's action log (PO-23) both record per-call execution. The destination's operation ledger is the agent-side record; the application-side logs stay as each application's evidence of record, and they are linked, not merged.

## Findings outside the mapping

- **Personal OS's published capabilities are not delegated.** The 13 functions on `/appport` and `/mcp` authorize by the caller's own FeltKit session (`Authority.required(fn.access)`). Only surface traffic (`interactions.ts`, `invocations.ts`) goes through AuthBoundry `personalos.*` decisions. An agent acting _for_ a person therefore cannot use them correctly today. This is the main platform gap for porting Personal OS (see the backlog). _Update (Slice 2.0):_ FeltKit now accepts an agent session naming a person (`X-AppPort-On-Behalf-Of`) and runs a capability as that person after an AuthBoundry decision proven as the agent ([FELTKIT-DELEGATED-EXECUTION-REPORT.md](FELTKIT-DELEGATED-EXECUTION-REPORT.md)). Personal OS still has to list its published capability names in `authority.capabilities` (2a). _Update (Slice 2a):_ done for tasks, reminders and the briefing; deletion is not delegable ([PERSONALOS-TASKS-BRIEFING-REPORT.md](PERSONALOS-TASKS-BRIEFING-REPORT.md)). _Update (Slice 2b):_ memory read and proposals are delegable; only the person makes memory trusted or forgets it, enforced in Personal OS's data operations ([PERSONALOS-MEMORY-REPORT.md](PERSONALOS-MEMORY-REPORT.md)). _Update (Slice 2c):_ projects (list, create, update) and documents (list, update) are delegable with separate grants; uploads, download links and document removal are not ([PERSONALOS-PROJECTS-DOCUMENTS-REPORT.md](PERSONALOS-PROJECTS-DOCUMENTS-REPORT.md)). _Update (Slice 3):_ research start, read, cancel and retry are delegable, bounded by a person-set budget in billable calls ([RESEARCH-RUNS-REPORT.md](RESEARCH-RUNS-REPORT.md)).
- **AppBoundry `GET /api/agent-work/provenance`** (`apps/cloud-portal/src/server.ts:588-591`). Verified and **not changed** (inventory only).
  - **What's there:** unlike its sibling routes, it has no per-resource check that the caller may read the requested `collection`/`id`.
  - **In production:** the server-wide gates at `server.ts:471-477` still require a signed-in user with tenant access.
  - **Outside production without a tenant host:** it is reachable unauthenticated.
  - **Also unverified:** whether `authorizeAgentWork` re-binds the client-supplied `session.delegatingPrincipalId` on the work and mutate routes.

  Both deserve a follow-up in AppBoundry.

- **License.** desktop-agents (Foundry) is AGPL-3.0, derived from ThinkAny's douchat. atomic-agent is a third-party MIT fork. ai-office is UNLICENSED. Any reuse of Foundry behavior must be a re-implementation.
- **The rule-based "agents" in product apps are not model agents** (TaskFlow, frame, multiplayer, saaskit, signal, competition, relationship-agent). Their AppPort capabilities are already agent-reachable. **TaskFlow's `assistant`** (`feltkit/assistant.ts:22-78`) is the cleanest existing reference for "act for a person under revocable delegation".

## Unresolved items and the evidence each needs

| ID                    | Question                                                        | Evidence needed                                                                                         |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SA-42                 | Mine reusable procedures from verified runs?                    | A destination use case and a measured benefit                                                           |
| OA-foundry-04, 05, 06 | Compute environments, Compute CI, PAX inspection                | Who owns Compute and PAX, and whether they are platform services                                        |
| OA-atomic-03          | Office and PDF document extraction                              | Where extraction runs (sandbox skill or service) without adding runtime dependencies to eve             |
| OA-atomic-13          | Vision description                                              | Verify eve's multimodal input support                                                                   |
| OA-prod-06, 07        | saaskit reserve/commit/release and per-agent spending authority | Whether budgets and metering are an AuthBoundry concern, a saaskit capability, or a destination concern |

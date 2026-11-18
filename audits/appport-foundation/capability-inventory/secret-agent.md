# secret-agent (appport-agent): capability inventory

- **Repo:** `/home/user/rkendel1/secret-agent`
- **Commit:** `20a451b` (Merge PR #16, `claude/clever-allen-2mjiak`). Working tree clean.
- **What it is (verified from source):** a Rust workspace (`crates/agent-core`, `crates/agent-model`, `crates/appport-agent`) that ships one binary, `appport-agent`. It is **not** a general tool-calling agent. Its main product is a closed loop that replaces the _implementation_ of one AppPort capability in a JS/TS project on disk: observe → deterministic plan → one model call that writes the code → apply → run the app and verify against its published contract → accept or roll back. The CLI holds that loop plus several research and evaluation harnesses. Model-facing tools exist only in the experimental "AppPort-native" arm (`crates/appport-agent/src/native.rs`), which uses a text protocol (`=== ACTION: <tool> ===`), not provider tool-calling.
- **Inspected:** every `.rs` file in the three crates (entry points and public APIs; the larger modules were skimmed for structure), `crates/appport-agent/host/appport-ipc-host.mjs`, `tools/appport-inspect/{package.json,inspect.mjs}` (header), the test file inventory, and the layout of `examples/`. For comparison: `/home/user/appport/packages/{protocol,integration,contract-builder,client,testing}/src` (exported functions), eve docs `docs/concepts/built-in-tools.md` and `docs/code-extension.mdx`, and `/home/user/eve2/examples/appport-agent/agent/tools/*`.
- **NOT inspected in depth:** the body of `strategy.rs` (context strategies and recovery policies), `arms.rs` oracle internals, `experiment.rs` spec schema, `report.rs` fields, `docs/**` and `fixtures/**` content, `scripts/*.sh`, `examples/customers-app` source, the full `inspect.mjs`, and the bodies of `contract-builder` and `generators` beyond their exports.
- **Tests:** I did **not** run any. `cargo test --offline --workspace` failed at dependency resolution (`no matching package named indexmap`): the crates are not vendored or cached. Every test label below therefore reads "tests exist, not run". Most `crates/appport-agent/tests/*` end-to-end tests are `#[ignore]` ("needs Node.js and `npm ci` in examples/customers-app").

Path prefix used below: `SA = /home/user/rkendel1/secret-agent`.

---

## Summary table

| id    | capability                                                                                             | kind                  | effect                              | status                               | destination              |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------- | ------------------------------------ | ------------------------ |
| SE-01 | Verified capability-implementation replacement (`run`; native `propose`)                               | CLI op + model tool   | read, write, execute                | complete (CLI) / experimental (tool) | **Integration required** |
| SE-02 | Dry-run plan (`plan --json`)                                                                           | CLI op                | read, execute                       | complete                             | **Internal only**        |
| SE-03 | `list_capabilities` (native tool)                                                                      | model tool            | read, execute                       | experimental                         | **Already available**    |
| SE-04 | `inspect` (native tool): contract view + dependents + must-preserve + source location                  | model tool            | read, execute                       | experimental                         | **Duplicate**            |
| SE-05 | `read` (native tool): project source file                                                              | model tool            | read                                | experimental                         | **Already available**    |
| SE-06 | `invoke` (native tool): observation-only capability call                                               | model tool            | read, execute                       | experimental                         | **Already available**    |
| SE-07 | `complete` / `limitation` (native control tools)                                                       | model tool            | write (rollback on limitation)      | experimental                         | **Internal only**        |
| SE-08 | Goal checks (`--goal-check`)                                                                           | CLI input + mechanism | execute, external-state (local app) | complete                             | **Contract adaptation**  |
| SE-09 | Model provider clients (openai-compatible, anthropic, command, scripted) with retry and redaction      | integration           | external-state                      | complete                             | **Already available**    |
| SE-10 | Free-gateway preflight (`preflight`, `--free-gateway`)                                                 | CLI op + integration  | external-state (read)               | complete                             | **Retire**               |
| SE-11 | `eval` (knowledge vs bare ablation)                                                                    | CLI op                | write, execute                      | complete                             | **Retire**               |
| SE-12 | `arm-eval` (bare vs context vs native, with oracle)                                                    | CLI op                | write, execute                      | complete                             | **Retire**               |
| SE-13 | `code-eval` + generic coding loop for ordinary repos                                                   | CLI op + mechanism    | write, execute                      | complete                             | **Duplicate**            |
| SE-14 | `experiment` (spec-driven strategy ablations)                                                          | CLI op                | write, execute                      | complete                             | **Retire**               |
| SE-15 | Typed contract model, parse, `unmodeled` drift detection                                               | internal              | read                                | complete                             | **Duplicate**            |
| SE-16 | Manifest structural validation (`Contract::validate`)                                                  | internal              | read                                | partial                              | **Duplicate**            |
| SE-17 | Protocol rules port + contract digest (parity with JS)                                                 | internal              | read                                | complete                             | **Duplicate**            |
| SE-18 | Declared integration graph                                                                             | internal              | read                                | complete                             | **Duplicate**            |
| SE-19 | Replacement boundary (compatibility + handover gates + dependents)                                     | internal              | read                                | complete                             | **Duplicate**            |
| SE-20 | Project observation (static JS/TS scan)                                                                | internal              | read                                | complete                             | **Internal only**        |
| SE-21 | Deterministic planner (edit boundary, least-privilege permissions, probe plan, checks, refusals)       | internal              | read                                | complete                             | **Internal only**        |
| SE-22 | Schema conformance check + deterministic input synthesis                                               | internal              | read                                | complete                             | **Internal only**        |
| SE-23 | Verification evaluation + judge (baseline vs candidate)                                                | internal              | read                                | complete                             | **Internal only**        |
| SE-24 | Local IPC host (runs the app from disk under a scoped session)                                         | internal              | execute                             | complete                             | **Internal only**        |
| SE-25 | Evidence collection (baseline/candidate probing, regression replay)                                    | internal              | execute, external-state (local app) | complete                             | **Internal only**        |
| SE-26 | Bounded edit apply / verified rollback                                                                 | internal              | write                               | complete                             | **Internal only**        |
| SE-27 | Run safety: project lock, uncommitted-change guard, secret hiding, redacted report and recovery record | internal              | write (tmp lock, report)            | complete                             | **Internal only**        |
| SE-28 | `tools/appport-inspect` surface/fixture drift generator                                                | build tool            | read, write (fixtures)              | complete                             | **Retire**               |

**Counts:** Already available 4 · Direct port 0 · Contract adaptation 1 · Integration required 1 · Internal only 10 · Duplicate 7 · Retire 5 · Unresolved 0 (28 total).

---

## Per-capability detail

### SE-01: Verified capability-implementation replacement

- **What:** Given `replace <cap>@<ver>[: goal]`, plans a bounded change, asks a model only for the new implementation file, applies it, runs the app before and after, and keeps the change only if every contract-derived check passes (and, by default, goal evidence exists). Otherwise it rolls back and retries with feedback, up to `--max-attempts`.
- **Source:** CLI dispatch at `SA/crates/appport-agent/src/main.rs:239` (`"run" | "eval"`), loop at `SA/crates/appport-agent/src/run.rs:250` (`run`), preparation at `run.rs:58` (`prepare`). Model-tool form: `propose` at `SA/crates/appport-agent/src/native.rs:308`, dispatched at `native.rs:505-530`.
- **I/O:** in: project dir, intent string, ModelConfig, max attempts, goal check, `--accept-preserving`, `--allow-dirty`, host node path and timeout, `--context knowledge|bare`. out: `RunReport` JSON (outcome `accepted|rejected|limitation|provider-error|rollback-failed|interrupted`, attempts, verdicts, goal evidence, totals), a JSONL log, and exit codes 0/1/2/3/4/5 (`main.rs:300`). `propose` in: `{capability}` plus `=== FILE: path ===` blocks. out: `{verified, checks[], evidence[]}` or `{refused|problem}`.
- **Deps:** agent-core (SE-15..SE-23), agent-model (SE-09), Node.js, the project's own `@appport/server` in `node_modules`, and `git` (optional, for the uncommitted check).
- **Authn/authz:** none toward a caller. It runs locally with filesystem authority. The app runs under a synthetic principal `appport-agent` holding only the permissions the planner derives (`plan.rs:360-387`). Provider credentials are stripped from the app's environment (`host.rs:96-99`, `run.rs:256`).
- **Effect:** read, write (rewrites one source module), execute (spawns Node and runs model-written code). Reversible: a failed attempt is rolled back and the rollback is digest-verified (`edit.rs:264`). An accepted change stays on disk, and nothing is committed to git.
- **Tests:** `SA/crates/appport-agent/tests/loop.rs` (`demo_completions_reject_then_accept`, `an_edit_outside_the_boundary_is_never_written`, `a_contradicted_verification_is_rejected_and_rolled_back`, `an_implementation_that_does_not_load_fails_every_runtime_check`, `an_unusable_response_is_fed_back_and_retried`, `the_published_manifest_matches_the_offline_fixture`, all `#[ignore]` without Node). `SA/crates/appport-agent/tests/readiness.rs` (ra01–ra10, mostly `#[ignore]`; `ra06_a_second_run_on_the_same_project_is_refused` is not ignored). `native.rs` unit tests cover only parsing. **Label: tested (tests exist, not run).**
- **Status:** complete for the CLI. The `propose` tool is experimental: native.rs:1 says "experimental; off unless the three-arm evaluation selects it".
- **Destination: Integration required.** This is the only distinct behaviour neither AppPort nor eve has: a contract-gated, rollback-safe "change one capability's implementation" workflow. In eve it needs a sandbox (Node + project checkout), a model step, and AppPort verification libraries. It is not an AppPort capability of a target app.

### SE-02: Dry-run plan

- **Source:** `SA/crates/appport-agent/src/main.rs:217` → `run.rs:58` `prepare` → `SA/crates/agent-core/src/plan.rs:153` `plan`.
- **I/O:** in: project, intent. out: `Plan` JSON (editable files, read-only context, permissions, probes, checks, `Decision` log with facts) or a refusal (`contract.invalid`, `target.builtin`, `target.undeclared`, `target.stream`, `source.undeclared`, `source.handler`, `contract.unverifiable`).
- **Deps:** Node (it starts the app once to read `appport.manifest@1`). **Auth:** none. **Effect:** read and execute (spawns the app with no permissions). No writes.
- **Tests:** `SA/crates/agent-core/tests/agent.rs` (`plans_the_replacement_without_a_model`, `refuses_what_it_cannot_ground`); unit tests in `plan.rs`. Tests exist, not run.
- **Status:** complete.
- **Destination: Internal only.** It is the dry-run face of SE-01's planner (SE-21). Expose it as a `dryRun` option of SE-01, not as a separate capability.

### SE-03: `list_capabilities`

- **Source:** `SA/crates/appport-agent/src/native.rs:225` (`list`). It calls `collect::discover` (`collect.rs:30`), which starts the app with no permissions and requests `appport.manifest@1`.
- **I/O:** in `{}`. out: `{application, capabilities:[{capability, kind, effect, description, authorization, builtin}]}`.
- **Effect:** read and execute (spawns the local app). **Auth:** none. **Tests:** none specific (covered only via the ignored arms tests). Untested in isolation.
- **Status:** experimental.
- **Destination: Already available.** It does the same thing as `examples/appport-agent/agent/tools/appport_capabilities.ts`, which reads the manifest, except that it reads it over local IPC.

### SE-04: `inspect`

- **Source:** `SA/crates/appport-agent/src/native.rs:248`. It combines `Contract::inspect` (`SA/crates/agent-core/src/appport/knowledge/inspect.rs:116`), `Contract::replacement_boundary` (`replacement.rs:227`), and the project's `declaredIn`/`implementedIn`/`imports` (SE-20).
- **I/O:** in `{capability:"name@ver"}`. out: `{contract: CapabilityView (fields, required, effect, authorization, failures, verification methods, explicit unknowns), dependents, mustPreserve, verification, source}`.
- **Effect:** read. **Tests:** `SA/crates/agent-core/tests/knowledge.rs` (`inspect_reports_inputs_outputs_and_required_fields`, `absent_declarations_are_unknown_never_no`, `snapshot_capability_view`, `replacement_boundary_lists_dependents_constraints_and_gates`, …). Tests exist, not run.
- **Status:** experimental (the tool); the knowledge pieces are complete.
- **Destination: Duplicate.** The schema, effect and authorization come from `appport_contract`. Dependents and must-preserve are served by `@appport/integration` `deriveGraph` (`/home/user/appport/packages/integration/src/graph.ts:157`) and `assessReplacement` (`readiness.ts:198`), which uses `compareManifests`. The one unique part, the source location, belongs to SE-20 inside SE-01.

### SE-05: `read`

- **Source:** `SA/crates/appport-agent/src/native.rs:268`. Only observed project source files, path-normalised, 48 KiB cap.
- **Effect:** read. **Tests:** none specific. **Status:** experimental.
- **Destination: Already available.** eve's built-in `read_file` (`/home/user/eve2/docs/concepts/built-in-tools.md`, "read_file") over the sandbox covers it.

### SE-06: `invoke` (observation only)

- **Source:** `SA/crates/appport-agent/src/native.rs:281`. It refuses anything whose `effect != observation` and starts a fresh app process holding exactly that capability's declared `authorization`.
- **I/O:** in `{capability, input}`. out `{ok, output}` or `{ok:false, error:{code,message}}`.
- **Effect:** read and execute (local app). **Auth:** a synthetic service principal granted the capability's own permissions. There is no delegation.
- **Tests:** none specific. **Status:** experimental.
- **Destination: Already available.** `appport_invoke.ts` already sends observation calls directly (outside work) under AuthBoundry delegation, which is stronger than this tool.

### SE-07: `complete` / `limitation`

- **Source:** `SA/crates/appport-agent/src/native.rs:506-529` (`complete` is refused unless a verified proposal is applied; `limitation` undoes any applied change via `undo`, `native.rs:428`).
- **Effect:** write (rollback). **Status:** experimental.
- **Destination: Internal only.** These are turn-control signals of the native loop. In eve they become the result shape of the SE-01 workflow (accepted / limitation), not tools.

### SE-08: Goal checks

- **Source:** `SA/crates/appport-agent/src/goal.rs:28` (`GoalCheck`), `goal.rs:80` (`run_goal_check`), `goal.rs:135` (`read_goal_check`). Used by `run.rs` and by the arm-eval oracle.
- **I/O:** a JSON `{description, steps:[{capability:"n@v", input, expect:[{at, equals}]}]}` with `{"$step":n,"at"|"input":ptr}` references. Each step must answer `ok`. A check that passes on the unchanged project is an error, because it measures nothing.
- **Effect:** execute (fresh app process; consequential calls are allowed against the local copy). **Auth:** the app is granted the permissions the steps' capabilities declare.
- **Tests:** `readiness.rs` `ra03_*` (ignored without Node). Tests exist, not run.
- **Status:** complete.
- **Destination: Contract adaptation.** AppPort already defines a declarative behaviour format, `appport.replacement-scenario/1` / `appport.replacement-suite/1` (`/home/user/appport/packages/integration/src/scenario.ts`; `compareBehavior` in `behavior.ts:277`). Goal checks should be re-expressed in that format. The "must fail before, pass after" rule is the one semantic to keep, because scenarios assert equivalence and goal checks assert a change.

### SE-09: Model provider clients

- **Source:** `SA/crates/agent-model/src/providers.rs:43` (`connect`): `OpenAiCompatibleModel` (`:177`, `POST {base}/chat/completions`), `AnthropicModel` (`:261`, `POST {base}/v1/messages`), `CommandModel` (`:350`, stdin/stdout), `ScriptedModel` (`:413`). Retry with backoff at `providers.rs:74`. Secret redaction at `gateway.rs:112`.
- **Auth:** an API key from the env var named by `api_key_env`.
- **Effect:** external-state (network calls, paid tokens).
- **Tests:** `SA/crates/agent-model/tests/providers.rs` (10), `reliability.rs` (7). Tests exist, not run.
- **Status:** complete.
- **Destination: Already available.** eve's model configuration (AI SDK providers, as in `examples/appport-agent` `anthropic(...)`) replaces it. The `scripted` provider maps to eve's mock model for e2e (`EVE_E2E_MODEL=mock`).

### SE-10: Free-gateway preflight

- **Source:** `SA/crates/agent-model/src/gateway.rs:237` (`preflight`), allowlist `gateway.rs:24` (`nvidia/nemotron-3.5-lightning-free`), base URL `https://ai-gateway.vercel.sh/v1`. CLI at `main.rs:506`.
- **Effect:** external-state (it reads the gateway catalog and makes one minimal completion).
- **Tests:** `SA/crates/agent-model/tests/gateway.rs` (9), `SA/crates/appport-agent/tests/free_gateway.rs`. Tests exist, not run.
- **Status:** complete.
- **Destination: Retire.** It is a cost guard for this repo's research runs and has no agent-facing value in eve.

### SE-11 / SE-12 / SE-14: `eval`, `arm-eval`, `experiment`

- **Source:** `SA/crates/appport-agent/src/eval.rs:169`, `arms.rs:826` (with the oracle at `arms.rs:277` and provenance at `arms.rs:731`), `experiment.rs:121/172` and `main.rs:445`.
- **Effect:** write (copies projects, writes reports under `--out`) and execute (runs models and apps).
- **Tests:** `SA/crates/appport-agent/tests/arms.rs` (ignored), `experiments.rs` (4), `loop.rs::eval_runs_every_arm_on_fresh_copies_and_aggregates` (ignored), plus unit tests in `arms.rs` and `experiment.rs`. Tests exist, not run.
- **Status:** complete.
- **Destination: Retire.** These are research harnesses comparing prompting arms of this agent. Once SE-01 moves to eve, measure it with `eve eval` fixture suites (see the e2e section of `/home/user/eve2/AGENTS.md`) rather than porting these.

### SE-13: `code-eval` + generic coding loop

- **Source:** `SA/crates/appport-agent/src/main.rs:349`, `coding.rs:279` (`run_coding`), `coding.rs:961` (`coding_eval`), `coding.rs:56` (`run_command`: test command in its own process group with credentials stripped), `SA/crates/agent-core/src/generic.rs:132` (`plan_coding`: failing tests → imports → edit boundary of at most 4 files, test files never editable), and `strategy.rs` (context strategies `minimal|observed|dependency-aware|appport-aware`; recovery policies `feedback|expand-context|stop-on-repeat`).
- **Effect:** write and execute (runs arbitrary repo test commands).
- **Tests:** `SA/crates/agent-core/tests/generic.rs` (4), `SA/crates/appport-agent/tests/coding.rs` (ignored), `experiments.rs`. Tests exist, not run.
- **Status:** complete.
- **Destination: Duplicate.** eve-code (`/home/user/eve2/docs/code-extension.mdx`) plus built-in `bash`/`edit_file` and eve-bench cover coding on ordinary repos. The one idea worth noting for eve-code is "test files are never editable", but it is not a capability.

### SE-15: Typed contract model and drift detection

- **Source:** `SA/crates/agent-core/src/appport/knowledge/mod.rs:72` (`Contract`), `contract.rs`, `capability.rs`, `integration.rs`, `schema.rs`, `literal.rs`, `verification.rs`; `Contract::unmodeled` (`mod.rs:164`).
- **Tests:** `tests/fixtures.rs` (9), `tests/surface.rs` (4). Tests exist, not run.
- **Destination: Duplicate.** It is a Rust mirror of `@appport/protocol` types. In TypeScript (eve) the published types are used directly.

### SE-16: Manifest structural validation

- **Source:** `SA/crates/agent-core/src/appport/knowledge/validate.rs:53`. The file header admits that `lintIntegration`, `lintAgentContract` and `lintDependencyModel` are **not** ported, so this is partial.
- **Tests:** `tests/knowledge.rs` `validation_*`, `snapshot_validation_report`. Tests exist, not run.
- **Destination: Duplicate.** It is covered by `@appport/protocol` `lintIntegration` / `lintAgentContract` / `lintDependencyModel` (`/home/user/appport/packages/protocol/src/integration.ts:490/596/673`), `validateName`, `validateSemanticAnnotations`, and `@appport/contract-builder` `validate.ts`.

### SE-17: Protocol rules port and contract digest

- **Source:** `SA/crates/agent-core/src/appport/knowledge/rules.rs` (name, permission and application-id validation, capability and dependency refs, canonical JSON, `contract_digest_of_value` at `:383`).
- **Tests:** `tests/parity.rs` (10, JS-generated cases). Tests exist, not run.
- **Destination: Duplicate.** These are faithful ports of `@appport/protocol` (`contractDigest` at `protocol/src/digest.ts:73`, `validateName`, `parseDependencyRef`, …).

### SE-18: Declared integration graph

- **Source:** `SA/crates/agent-core/src/appport/knowledge/graph.rs:140`.
- **Tests:** `knowledge.rs` `graph_*`, `cross_application_targets_are_unresolved_not_invented`. Tests exist, not run.
- **Destination: Duplicate.** `@appport/integration` `deriveGraph` (`integration/src/graph.ts:157`) produces the same graph, with `resolved:false` nodes and `edgesOf`. The AppPort version is richer: it also takes observation coverage and mappings.

### SE-19: Replacement boundary

- **Source:** `SA/crates/agent-core/src/appport/knowledge/replacement.rs:227`. It combines §43 compatibility rules, `@appport/core` provider-handover gates and rejection codes, graph dependents, and verification hooks.
- **Tests:** `knowledge.rs` `replacement_boundary_lists_dependents_constraints_and_gates`, `contract_pin_changes_only_when_the_capability_contract_does`, `snapshot_replacement_boundary`. Tests exist, not run.
- **Destination: Duplicate.** It is covered by `@appport/protocol` `compareManifests`/`compareSchemas` (`protocol/src/compatibility.ts:436/239`) and `@appport/integration` `assessReplacement` (`readiness.ts:198`). This confirms the earlier assessment.

### SE-20: Project observation

- **Source:** `SA/crates/agent-core/src/observe.rs:146` (`observe`). A regex-level scan of JS/TS for `createApplication`, `defineCapability({name,version,handler})`, handler modules, import graph and `@appport/*` deps. Symlinks out of the project are refused (`observe.rs:269-285`).
- **Effect:** read. **Tests:** `tests/agent.rs::observes_the_project_on_disk`, 5 unit tests in `observe.rs`. Tests exist, not run.
- **Destination: Internal only.** AppPort and eve have nothing equivalent, but it exists only to find the edit boundary for SE-01. Port it as an internal module of the SE-01 workflow.

### SE-21: Deterministic planner

- **Source:** `SA/crates/agent-core/src/plan.rs:153` (`plan`), checks list `plan.rs:510-551` (`edit.boundary`, `runtime.load`, `contract.identity`, `contract.valid`, `output.conformance`, `failures.declared`, `integration.failures`, `behavior.regression`, `integration.verify`), least-privilege permissions `plan.rs:360-387`, model task builders `plan.rs:606-644`.
- **Tests:** `tests/agent.rs` (7). Tests exist, not run.
- **Destination: Internal only.** It is the core of SE-01. Keep it eve-internal. Where AppPort has an equivalent (`planVerification`, `integration/src/verification.ts:40`), use it.

### SE-22: Schema conformance + synthesis

- **Source:** `SA/crates/agent-core/src/conformance.rs:33` (`check`), `:339` (`synthesize` with seed and overrides).
- **Tests:** 4 unit tests in `conformance.rs`. Tests exist, not run.
- **Destination: Internal only.** The conformance check duplicates AppPort runtime validation. Deterministic input **synthesis** from a schema has no AppPort equivalent that I found (grep for synthesis/sample helpers in `packages/*/src` found nothing relevant). It stays an internal probe generator for SE-25.

### SE-23: Verification evaluation + judge

- **Source:** `SA/crates/agent-core/src/verify.rs:121` (`evaluate_state`), `:183` (`evaluate_event`), `:201` (`outcome`), `:259` (`judge`).
- **Tests:** `tests/agent.rs` `judges_*` (3), 2 unit tests. Tests exist, not run.
- **Destination: Internal only.** `evaluate_*` duplicates `@appport/integration` `evaluateVerification` (`verification.ts:84`) and `findingsFromStateEvidence`, which should be reused. `judge` (baseline vs candidate plus edit boundary plus contract identity) is SE-01-specific; for its behaviour comparison, consider `compareBehavior` (`behavior.ts:277`).

### SE-24: Local IPC host

- **Source:** `SA/crates/appport-agent/src/host.rs:89` (`Host::start`), `:197` (`request`), `:219` (`subscribe`), `:240` (`events_named`); `SA/crates/appport-agent/host/appport-ipc-host.mjs` (wraps the project's `AppPortConnection`, synthetic principal `appport-agent`, permissions from argv).
- **Effect:** execute (spawns `node`). Credentials are stripped.
- **Tests:** only through the ignored loop and readiness tests.
- **Destination: Internal only.** In eve it would run inside the sandbox via `bash`, or in-process through `@appport/testing` or `AppPortConnection`. It is never model-exposed.

### SE-25: Evidence collection

- **Source:** `SA/crates/appport-agent/src/collect.rs:50` (`collect`). It runs the probe plan in a fresh process, replays the baseline's regression inputs against the candidate, and probes at most 5 existing records.
- **Effect:** execute and external-state, limited to the local isolated process; consequential calls are allowed there.
- **Destination: Internal only.** Part of SE-01.

### SE-26: Bounded edit apply / verified rollback

- **Source:** `SA/crates/appport-agent/src/edit.rs:22` (`parse`), `:227` (`apply`, refuses symlinks), `:264` (`rollback`, digest-verified).
- **Tests:** 8 unit tests in `edit.rs`, plus `readiness.rs::ra01_a_symlink_out_of_the_project_is_never_followed` (ignored). Tests exist, not run.
- **Destination: Internal only.** Its guarantees (boundary, digest-verified undo) should carry into SE-01. eve's `write_file`/`edit_file` do not provide the undo record.

### SE-27: Run safety

- **Source:** `SA/crates/appport-agent/src/run.rs:157` (`ProjectLock`, a lock in the temp dir keyed by canonical path), `run.rs:216` (`uncommitted`, via `git status`), `run.rs:236` (atomic redacted report), `HostConfig::hiding` (`host.rs:49`), in-flight recovery record (`report.rs`).
- **Tests:** `readiness.rs` `ra02`, `ra05`, `ra06` (not ignored), `ra10`. Tests exist, not run.
- **Destination: Internal only.** Durable state and concurrency in eve come from sessions and the workflow world. The uncommitted-change guard and secret stripping become workflow preconditions.

### SE-28: `tools/appport-inspect`

- **Source:** `SA/tools/appport-inspect/inspect.mjs` (pins `@appport/core@1.2.0`, `protocol@1.1.0`, `schema@1.1.0`, `testing@1.1.3`), `scripts/check-appport-drift.sh`.
- **Destination: Retire.** It exists only to keep the Rust mirror (SE-15..19) in sync with the packages. eve would consume the packages directly.

---

## Port details

### SE-01: Verified capability-implementation replacement (Integration required)

1. **Source to preserve/reuse:** the loop structure and policies in `run.rs:250` (attempts, feedback, outcome taxonomy, exit-code semantics); the planner `plan.rs:153` (refusal codes, least-privilege permissions, check list); `observe.rs:146`; `edit.rs` apply/rollback with digest verification; `collect.rs:50` baseline/candidate replay; `conformance::synthesize`; `verify::judge`; the goal-evidence rule (`--accept-preserving` is opt-in). Port the logic to TypeScript. Do **not** port SE-15..19: call `@appport/protocol` (`compareManifests`, `contractDigest`, `lint*`) and `@appport/integration` (`deriveGraph`, `assessReplacement`, `planVerification`, `evaluateVerification`, `compareBehavior`) instead.
2. **Destination shape:** an **eve-internal workflow/tool**, not an AppPort capability of a target app. It edits a source tree and runs it, which is coding-agent work. A sketch, if exposed as an eve tool: `appport_replace_implementation`, input `{ projectPath, capability: "name@version", goal, goalCheck?: ReplacementSuite, acceptPreserving?: boolean, maxAttempts?: number, dryRun?: boolean }`, output `{ outcome: "accepted"|"rejected"|"limitation"|"provider-error"|"rollback-failed", plan, attempts[{files, verdict{checks[]}}], goalEvidence, changedFiles }`. Effect: write + execute inside the sandbox. Idempotency: not idempotent on the project tree. Make it safe by requiring a clean tree (as SE-27 does) and recording the pre-change digests, so a repeat on the same session is detected and rolled back rather than re-applied. If it must be an AppPort capability (for example a "dev-agent" AppPort app), use `dev.capability.replace@1`, `effect: consequential`, `idempotency` keyed by `(project digest, capability, goal digest)`.
3. **Required services/runtime:** an eve sandbox with Node ≥ 22, the project checkout with `npm ci` done, and `@appport/server`, `@appport/protocol` and `@appport/integration` resolvable. A model for the single implementation step (eve model config). `git` for the clean-tree check.
4. **AuthBoundry permission:** proposed `appport.dev.implementation.replace` (it writes source and runs it). The verification session inside the sandbox keeps the planner-derived, least-privilege permission set under a synthetic local principal. It must never use the human's delegated AppPort credential, because probes make consequential calls against a local copy.
5. **Provenance/evidence to record:** contract digest before and after (`contractDigest`), plan decisions with their facts, files changed with before/after sha256, each attempt's verdict checks, verification method outcomes, goal-check run (fails before, passes after), model id and token usage, rollback verification result, and an `acceptPreserving` flag when goal evidence was waived.
6. **Tests to carry over/write:** port the scenarios from `loop.rs` (reject-then-accept, out-of-boundary edit never written, contradicted verification rolled back, non-loading impl fails all runtime checks, unusable response retried) and `readiness.rs` (ra01 symlink, ra02 secrets never reach app or log, ra03 goal evidence, ra05 uncommitted, ra06 concurrent run, ra10 interrupted-run recovery) as eve scenario tests, using a scripted/mock model against `examples/customers-app`. Add an eve e2e eval with a mock model.
7. **Known platform gaps:** eve has no built-in "verified rollback" primitive for file edits. Spawning the app per probe needs sandbox process control. `@appport/integration` `compareBehavior` expects `TargetFactory` targets, so it needs an adapter over an IPC or in-process app. Schema-driven input synthesis is not in AppPort. The JS-source observer is regex-based and will miss non-literal `defineCapability` calls; it records those as findings rather than guessing.

### SE-08: Goal checks (Contract adaptation)

1. **Source:** `goal.rs` (step references, fail-before/pass-after rule).
2. **Destination contract:** express goal checks as an `appport.replacement-suite/1` document (`integration/src/scenario.ts`, validated with `validateSuite`/`lintScenarioAgainst`) with an added marker meaning "expected to differ from original" (for example a suite-level `purpose: "goal"`). This is an AppPort format extension and needs an AppPort decision; until then, keep the current `GoalCheck` JSON as an SE-01 input. No standalone capability, no idempotency (read-only definition).
3. **Services:** same as SE-01.
4. **AuthBoundry permission:** none separately; it runs under SE-01's `appport.dev.implementation.replace`.
5. **Provenance:** the suite digest, and the before (fail) and after (pass) results for each step.
6. **Tests:** `readiness.rs` `ra03_*` and the arms oracle test `an_unchanged_project_never_achieves_a_goal`.
7. **Gaps:** AppPort scenarios assert equivalence in concept space. "Goal achieved" (a deliberate difference) is not modelled in AppPort today.

---

## Notes on the earlier assessment

Confirmed. secret-agent's contract knowledge (SE-15..SE-19, about 3.4k lines of Rust) is a deliberate mirror of the published `@appport/protocol` and `@appport/integration` surface, kept in parity by JS-generated fixtures (`tests/parity.rs`, `tests/surface.rs`, `tools/appport-inspect`). The AppPort packages at HEAD `a6c2c61` now export the same operations: `compareManifests`, `contractDigest`, `lintIntegration`, `deriveGraph`, `assessReplacement`, `planVerification`, `evaluateVerification`, and `compareBehavior`. They are classified Duplicate, not "Already available via manifest". The manifest serves the data; these library functions serve the analysis. The parts of secret-agent with no destination equivalent are the closed implementation-replacement loop and its internals (SE-01, SE-20..SE-27) and the goal-check semantics (SE-08).

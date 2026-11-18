# Contract-verified replacement (slice 8)

**Result.** eve's AppPort dependency can now be replaced through a Resolver `agent` reference, verified against declared capability contracts, with no rebuild, redeploy or restart of the agent:

- Resolver verifies every candidate before it can become active, and records who made each change and why. It refuses breaking, effect-changed, missing, foreign, unreachable and unlisted candidates without moving the active resolution.
- eve verifies each new operation against the binding's pinned contract, and refuses an origin whose served contract drifted.
- Every operation keeps the implementation it was prepared against, through replacement, rollback, crashes and recovery.
- Authority does not move:
  - the deployment operator alone changes the dependency;
  - the agent only reads it;
  - an end user cannot reach it;
  - the operator's Resolver key gets no application authority.

**Where it lives.** The resolution is implemented in the example agent, as this slice's proof. Making Resolver a first-class runtime capability of the deployed agent service is the agreed direction, and it needs a research document first (§9).

## 1. Baseline (established before any change)

| Repository                  | State                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rkendel1/personalOS`       | Slice 6 (`28c4573`, `3c3e3c2`) was **not on main**. It is now merged with the CI repair: PR #31, `90ae367`. That is the first green Personal OS CI since at least #24; main had been red at the measure step, so its tests and builds had not run in CI |
| `rkendel1/eve2`             | main `0742ffc` (slice 6 `66c7408` via #16; slice 7's assessment via #17). **No eve2 pull request has any GitHub Actions run**, #16 and #17 included; only CodeRabbit (skipped) reports. Every eve result in these reports is from local runs            |
| `rkendel1/feltkit`          | main `d68219c`. **Delegated `/appport` is unpublished**: 0.3.30 and 0.3.32 lack it                                                                                                                                                                      |
| `rkendel1/appport`          | main `a6c2c61`: `@appport/protocol` 1.5.0 (`capabilityDigest`, `compareManifests`)                                                                                                                                                                      |
| `rkendel1/appboundry`       | main `9f84020`                                                                                                                                                                                                                                          |
| `rkendel1/flow_db` (FeltDB) | main `0f5049e`                                                                                                                                                                                                                                          |
| `@appport/resolver`         | 0.4.1, from `rkendel1/resolver`                                                                                                                                                                                                                         |

**Slice 6's end-to-end tests are not exercised by eve CI.** eve's CI step for the example sets neither `PERSONALOS_DIR` nor `FELTKIT_SDK_DIR`, and no Actions run in any case. They pass locally, now against Personal OS main.

**The pinned FeltKit has no delegation.** Personal OS pins FeltKit 0.3.30. Under it, its four real-delegation suites skip by their declared reason; under FeltKit main they pass. So the delegated path of slices 2–6 has never run on a published FeltKit.

### Replacement machinery that already existed

| Mechanism                                                    | What it already did                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilityDigest`, `compareManifests` (`@appport/protocol`) | Per-capability contract digest (definition plus integration declaration); compatible versus breaking per §43                                                                                                                                                                                                                                                                          |
| **Resolver `agent` references** (`targets.js` `checkAgent`)  | Target `{ origin, application, capabilities: { "name@version": "sha256:…" } }`. On every write, before storing:<br>• discover the origin over AppPort (`/.well-known/appport`, outbound policy);<br>• check the application id;<br>• recompute each pinned digest from the served manifest;<br>• refuse any difference, a capability not served, an unreachable or an unlisted origin |
| Resolver revisions, history, rollback, grants, governance    | Compare-and-set writes (`expectedRevision`); history with actor and reason; `rollback` **re-runs the target checks**; grants per key and reference; optional signed authorization                                                                                                                                                                                                     |
| Resolver consumer `dependencies: [{ ref, contract? }]`       | Informational only: shown in the impact view, never checked                                                                                                                                                                                                                                                                                                                           |
| FeltKit model references                                     | The only resolved dependency kind in FeltKit; agent and endpoint references are "Not yet"                                                                                                                                                                                                                                                                                             |
| eve per-operation contract pins (slice 4)                    | `capabilityDigest` pinned at prepare; `compareManifests` against the _current_ manifest before every dispatch, retry and recovery                                                                                                                                                                                                                                                     |
| eve's AppPort dependency                                     | A **static `APPPORT_URL`**                                                                                                                                                                                                                                                                                                                                                            |

### The gap this slice closed

1. **Resolution.** eve did not resolve its dependency through Resolver; changing it meant editing an environment variable and restarting.
2. **In-flight identity.** An operation recorded its contract but not its implementation, so a retry or recovery went wherever `APPPORT_URL` pointed at that moment.
3. **Drift at use time.** Resolver verifies at write time only. Nothing re-checked an origin whose served contract changed behind an unchanged binding.

## 2. Selected dependency

**eve's agent → the inventory AppPort application** (`catalog.lookup`, `catalog.reserve`, `catalog.reservation`, `probe.applykeyed`).

**Why this dependency:**

- It is an existing, real AppPort contract with consequential and observation capabilities, durable operations, idempotency and AuthBoundry delegation.
- It can run as two deployments without inventing a product.

**The deployments and candidates (the stand-ins are labelled in the test file):**

|                       | What it is                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**                 | The original deployment                                                                                                                                                                                                                                         |
| **B**                 | A replacement deployment of the same application at another origin. It shares A's store, so the same AuthBoundry and grants                                                                                                                                     |
| **Forwarding origin** | A logging proxy to the live deployment, so two live origins serve one implementation and routing is observable                                                                                                                                                  |
| Refused candidates    | The same host started breaking (a required input field), effect-changed (consequential → observation) or with a capability removed; Resolver's own origin (a different application); a closed port; a hanging origin; an origin not on Resolver's outbound list |

## 3. Responsibilities kept separate

| Concern                           | Owner                                                                                     | This slice                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity: which implementation    | Resolver `agent` reference                                                                | unchanged                                                                                                                                              |
| Contract: what is required        | The binding's pinned digests, verified by Resolver on every write and rollback            | **eve re-verifies** the served contract against the pins before each new operation (`CONTRACT_MISMATCH`, `CONTRACT_NOT_PINNED`, `DEPENDENCY_MISMATCH`) |
| Authority: who may invoke         | AuthBoundry, at the application                                                           | unchanged                                                                                                                                              |
| Authority: who may replace        | Resolver grants: the deployment operator's key (`read,write` on `ref://prod/eve/*`)       | the agent's key is `read` on one reference                                                                                                             |
| Resolution: what satisfies it now | Resolver                                                                                  | **eve resolves for each new operation** (`APPPORT_AGENT_DEPENDENCY`), with no fallback to `APPPORT_URL`                                                |
| Execution: what happened          | eve's operation ledger                                                                    | **each operation records `implementation`** (reference, revision, origin, application, pins); every attempt verifies and sends there                   |
| Evidence: why it was accepted     | Resolver history (actor, reason, revision), and the ledger's implementation per operation | `GET /work` shows each operation's implementation                                                                                                      |

**The rule, in principle:** _Resolver authority belongs to the owner of the dependency lifecycle._

- The deployment operator controls the deployment's references.
- The agent receives runtime read access to resolved values, not Resolver administration.
- End users consume the agent and get no control over its dependencies.
- The operator's Resolver key carries no application authority.

## 4. State transitions and evidence

| State                                                   | Where it exists                                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active                                                  | Resolver's current revision of the reference                                                                                                                                                 |
| Activated replacement                                   | A new revision. It exists only if Resolver verified the candidate: discovered, same application, every pinned digest served                                                                  |
| Rejected candidate                                      | No revision. The write is refused with `resolver.incompatible-target` / `agent-unreachable` / `outbound-refused` and a precise message; the active revision is unchanged; nothing in history |
| Rollback                                                | A new revision restoring an earlier binding, re-verified (refused while that origin is down)                                                                                                 |
| Superseding                                             | Any later verified write, with `expectedRevision` compare-and-set; concurrent writes commit once                                                                                             |
| **Proposed, verified but inactive, pending activation** | **Do not exist.** Resolver has no dry-run or staged binding: verification and activation are one atomic write. Recorded as a gap; not built                                                  |

## 5. Acceptance test (real services)

```bash
node --test test/replacement.test.mjs
```

Run in `examples/appport-agent`. **Result: 13/13 passed**, with no AuthBoundry or Resolver processes left.

**Real:** eve (`eve start`, scripted model); the Resolver server (`@appport/resolver` 0.4.1 CLI, **production outbound policy**: only listed origins); the inventory application with its private AuthBoundry and FeltDB.

| #      | Test                       | Shows                                                                                                                                                                                                                              |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | Original                   | Resolves through Resolver, verified against the pins, executes; the ledger records `{ origin A, ref, revision 1 }` and the pinned digest                                                                                           |
| 8      | No fallback                | Resolver down (with a decoy `APPPORT_URL` pointing at the live A): `DEPENDENCY_UNRESOLVED`, nothing reaches A. Implementation down: `DEPENDENCY_UNAVAILABLE`, no operation prepared                                                |
| 2–6    | Replacement                | B verified and activated by the operator; the next work runs at B (B's provenance; not A's); the contract digest is unchanged                                                                                                      |
| 7      | Negatives                  | breaking, effect-changed, missing, other application, closed, hanging, unlisted, and pins substituted with a breaking digest: each refused with its reason; the active revision and origin are unchanged; work still runs at B     |
| —      | Unauthorized and duplicate | eve's own key cannot write; two concurrent writes at one revision commit once (the other is refused as stale)                                                                                                                      |
| —      | Who owns the dependency    | An end user's eve token is refused by Resolver; no Resolver key appears in eve's answers or store; the operator's key is refused by the application; every revision's actor is `deployment-operator`                               |
| 9      | Authority invariance       | Bob, ungranted, is refused at B as at A; Alice's decisions at A and B name the same agent, outcome and authority application                                                                                                       |
| —      | Stale origin               | B redeployed with a breaking contract behind the unchanged binding: `CONTRACT_MISMATCH`, nothing sent                                                                                                                              |
| 10, 12 | In flight, and rollback    | An operation uncertain at B (B crashed while completing); rollback to A is refused while A is down, then succeeds; the retried operation is checked against B, **never sent to A**; new work goes to A at the rolled-back revision |
| 10     | Both live                  | An operation prepared at A (eve crashed before sending); the dependency moved to the forwarding origin; on recovery it is sent **to A**, not through the new resolution; new work goes through the forwarder                       |
| —      | Crash during verification  | Resolver killed while verifying a hanging candidate: nothing stored; the active resolution unchanged after restart                                                                                                                 |
| 11     | Audit after restart        | After restarting Resolver and eve: Resolver history (create, update, update, rollback; reasons; actor) and every operation's implementation revision are intact; no refused candidate is in the history                            |
| —      | Unpinned capability        | A binding that does not pin `probe.applykeyed`: it is refused (`CONTRACT_NOT_PINNED`) and not sent; pinned capabilities still run                                                                                                  |

**Compatibility rules exercised:**

- **Resolver:** application id equality; exact `capabilityDigest` equality per pinned `name@version`; served or not; reachability and the outbound policy.
- **eve:** the same equality against the binding at use time. Slice 4's `compareManifests` still governs an operation whose implementation now serves a different contract.

## 6. Mutation checks

Each one is applied to the source, then `test/replacement.test.mjs` is run and the source restored. Afterwards the sources were compared with a backup: identical.

| Mutation                                                                          | Caught by                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eve uses a served contract that differs from the pin                              | stale origin (plus cascades)                                                                                                                                                                                |
| eve uses a capability the binding does not pin                                    | unpinned capability                                                                                                                                                                                         |
| Resolver's write-time digest check skipped (in the installed `@appport/resolver`) | negatives; duplicates; authority; in flight; crash; audit                                                                                                                                                   |
| eve falls back to `APPPORT_URL` when Resolver cannot answer                       | no fallback (plus 9 cascades)                                                                                                                                                                               |
| An operation verified and sent where the dependency resolves _now_                | in flight; both live; audit                                                                                                                                                                                 |
| An operation sent where it resolves now, verification kept                        | **both live**. It first survived, masked: in the in-flight test the recorded implementation was down, so verification stopped it before dispatch. The both-live test was added for it, and it is now caught |
| Every call made on behalf of one fixed person                                     | authority invariance                                                                                                                                                                                        |

**7 of 7 caught.**

## 7. Regression

- **Full eve destination suite**, with FeltKit and Personal OS **main**: **160/160** (the earlier 147 plus these 13); one suite skips by design (the real-Anthropic-model test, no key); no AuthBoundry or Resolver processes left.
- **Personal OS (pinned FeltKit, CI):** green on #31 (161 pass, 5 skip with declared reasons). With FeltKit main: **166/166**, none skipped (the code is unchanged by this slice).
- **Typecheck, lint, format and repository guards:** `tsc`, `oxlint` (no warnings, after removing one spread fallback this slice added), `oxfmt`, `pnpm guard:invariants` and `pnpm guard:docs-budget` pass.

## 8. What is real, what is a stand-in, what is untested

| Real                                                                                                                                    | Stand-in (labelled)                                                                                                                                                                 | Untested                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolver server and policy; AppPort discovery and digests; the inventory application, AuthBoundry and FeltDB; eve; crashes and restarts | B shares A's store, and is a second deployment rather than a different code base; the forwarding origin; candidates are the same host with contract switches; the model is scripted | A different code base implementing the same contract; replacement under real load or across hosts; Resolver multi-instance; governed (signed-authorization) changes; Resolver's change stream (eve resolves per new operation instead); model or endpoint dependency kinds |

## 9. Gaps and deferred work

1. **Resolver as a runtime capability of the deployed agent service (the agreed direction).**
   - Today each agent would implement this itself, as the example now does.
   - The proposal: a platform-level resolution surface consumed by eve agents, with typed dependency kinds, each with its own contract:
     - `agent` references, pinned capability digests;
     - `model` references, Resolver's provider and model checks, as FeltKit already has.
   - Stable references live in agent configuration, and resolution receipts go into execution evidence.
   - It needs a research document (a public API under eve's rules) before code.
2. **Re-pins are not checked for compatibility.**
   - Resolver accepts a re-pin to any contract the origin serves, breaking included, with no comparison against the previous pins.
   - The smallest correction is in `rkendel1/resolver`: `compareManifests` between the previous and new pins when they differ, refusing breaking ones without an explicit acknowledgement. Proposed, not done.
3. **No staged candidates.** Resolver cannot verify without activating, so "verified but inactive" and "pending activation" don't exist. If needed, that is a Resolver feature.
4. **The reconciler's read is not tested after replacement.** It is routed to the operation's implementation (`reconcileOperation`), but no test exercises a reconciled operation across a replacement.
5. **Consumer-declared contracts stay informational.**
6. **No change stream.** eve resolves once per new operation, so there is no subscription, cache or TTL. A change applies to the next operation.
7. **Delegated `/appport` is unpublished**, and **eve CI does not run** (§1). Both block hosted readiness; see the readiness assessment.

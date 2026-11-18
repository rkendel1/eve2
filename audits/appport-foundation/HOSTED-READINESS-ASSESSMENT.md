# Hosted-deployment readiness assessment

Written after slice 8 (contract-verified replacement), the last planned pre-hosting slice. **It decides nothing on its own:** hosted deployment should begin only after this evidence is reviewed.

**Short answer: not yet, and the blockers are specific and small in number.**

> **Update (FeltKit 0.3.33 published).** Prerequisite 1 is closed: Personal OS pins the published `@feltdb/feltkit` 0.3.33 (`rkendel1/personalOS` 7ed8099), and its suite passes on the installed package with **166 passed, 0 skipped**; under 0.3.30 it was 161 passed and 5 skipped. The published tarball's contents are identical to the candidate verified before release. eve's CI and the host decision remain open.

- The capability, identity, authority and execution designs are explicit and tested.
- What is missing is release and verification plumbing:
  - ~~the delegated path depends on an **unpublished FeltKit**~~ (closed: 0.3.33);
  - **eve's CI does not run at all**, so every eve result is local;
  - the existing Hetzner host offers **staging only**, and has no deployment path for eve or Resolver.
- A small, operator-only milestone is supportable now that the FeltKit release exists (§9).

## 1. Are the existing agents' tools and capabilities inventoried?

**Yes.**

- [`CAPABILITY-INVENTORY.md`](CAPABILITY-INVENTORY.md) covers the platform baseline, Stack-Agent, secret-agent, Personal OS (47, including AnywhereAide) and the other agents (54, including voice-agent).
- Each item is classified from source, with file references.
- Slice 7 re-derived voice-agent's 8 tools from source and corrected their classification.

## 2. Are capabilities consolidated, or explicitly classified as domain-specific?

**Yes, explicitly.**

| Area                                                                          | Disposition                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Personal OS tasks, reminders, briefing, memory, projects, documents, research | Delegated capabilities on Personal OS's own code (slices 2a–3)                                  |
| Interactions and invocations (AnywhereAide)                                   | Integrated through eve (slice 6)                                                                |
| Business tools of voice-agent                                                 | **Business-scoped**, outside person delegation (slice 7)                                        |
| Anything else                                                                 | Each item is listed as port, duplicate, internal-only or deferred in the backlog, with a reason |

## 3. Is parity verified against actual implementations?

**Yes for what was ported, now on a published FeltKit (0.3.33).**

- Every delegated capability runs Personal OS's own function through FeltKit's delegated `/appport`; there are no copies.
- The tests read Personal OS's records, audit trail and action log.
- The delegated suites skipped under 0.3.30; under the pinned, published 0.3.33 they run and pass (166 passed, 0 skipped).

## 4. Are identity and authority boundaries explicit and tested?

**Yes.**

| Boundary                                                                              | Evidence                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Agent versus person (on-behalf-of, per-capability grants, revocation)                 | Slice 2.0; slices 2a–3                                                   |
| External identity to person (two-sided linking, uniqueness, revocation)               | Slice 5 (13 tests, 12 of 14 mutations caught, 2 masked by a second gate) |
| Identity authority to agent (signed assertion, no caller-named person, reply routing) | Slice 6 (14 tests, 8 of 8 mutations caught)                              |
| Business versus person scope                                                          | Slice 7 (assessment)                                                     |
| Dependency lifecycle: operator versus agent versus end user                           | Slice 8 (13 tests, 7 of 7 mutations caught)                              |

**Limits:**

- Delegation uses FeltKit's **local** AuthBoundry only; hosted AuthBoundry cannot prove an agent credential (slice 2.0).
- Tenancy is not carried in delegation (slice 7).

## 5. Are execution, idempotency, recovery and provenance durable?

**Yes, in eve and in Personal OS.**

**eve:**

- the operation ledger with stable ids;
- AppPort idempotency keys;
- crash recovery and reconciliation by read;
- operator settlement;
- stall detection;
- the completion gate;
- contract pins and implementation identity.

**Personal OS:** FeltKit's audit trail and action log.

**Evidence:** tested with real crashes across slices 1, 4, 6 and 8.

**Limit:** the evidence is local runs only (§10).

## 6. Are contracts verified and replacements demonstrably safe?

**For AppPort-capability dependencies, yes**:

- Resolver verifies on every write and rollback.
- eve re-verifies at use.
- Operations keep their implementation.
- Breaking and drifted contracts are refused without moving the active resolution.

**Not yet:**

- model and endpoint dependency kinds;
- compatibility classification on re-pins (a Resolver change);
- the platform-level placement (a research document first).

## 7. Which capabilities are ready to run hosted?

The delegated path is in a published FeltKit (0.3.33) and Personal OS pins it. Code-complete and tested locally:

| Capability                                                                                   | State                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Personal OS direct use (web, Chrome, iOS)                                                    | **Ready.** It runs on the pinned, published FeltKit, CI is green (#31), and it uses no delegation |
| eve agent with delegated Personal OS tasks, reminders, briefing, memory, projects, documents | Release prerequisite met (0.3.33, pinned); needs eve CI and a host                                |
| Research through eve                                                                         | Same, plus a real web search provider and model configured                                        |
| AnywhereAide through eve (Multiplayer)                                                       | Same, plus the Multiplayer bridge deployed and its own end-to-end test run                        |
| AnywhereAide through eve (X)                                                                 | Same, plus a real X developer app and bot account; the X path is verified only against a stand-in |
| Contract-verified replacement                                                                | Needs Resolver deployed with a production outbound list and operator keys                         |
| voice-agent                                                                                  | Separate product, business-scoped; it has its own deployment story                                |

## 8. Which require additional work?

1. ~~**Publish FeltKit with delegated `/appport`, and pin Personal OS to it.**~~ Done: 0.3.33, pinned in Personal OS 7ed8099.
2. **Make eve2's CI run.** GitHub Actions has never run on any eve2 PR. Until it does, nothing in eve is verified outside one workstation. Also give the example's Personal OS and FeltKit end-to-end tests a CI job that sets `PERSONALOS_DIR` and `FELTKIT_SDK_DIR`.
3. **Hosted AuthBoundry, or a decision to stay local.** A hosted AuthBoundry needs the agent credential forwarded (slice 2.0 "not built"). Local AuthBoundry needs FeltKit's vault and a persistent volume.
4. **A deployment path for eve and Resolver on the target host.** AppBoundry runs AppBoundry artifacts; eve (a Nitro app) and Resolver have none documented.
5. **Real provider credentials** (model, X, web search) as FeltKit or Resolver secrets.
6. **Live Multiplayer and X verification.**
7. **Resolver as a deployed-service runtime capability**, if hosting should carry it from day one: a research document first.

## 9. The smallest hosted milestone the evidence supports

**H1: operator-only Personal OS plus eve, on one host, with no external surfaces and no customers.**

**What it contains:**

- **Personal OS** on FeltKit 0.3.33 (prerequisite 1, met), with its local AuthBoundry, vault and persistent volume.
- **eve's AppPort agent**, delegated by one operator-owned test account for tasks and memory (the most-tested paths), reached over loopback.
- **Resolver** with a production outbound list, if replacement is to be demonstrated live.

**What it excludes:** X, Multiplayer, research spend and voice.

**Acceptance:**

- the slice suites pass against the deployed processes;
- a restart keeps work and links;
- a revocation is honoured;
- no secrets appear in logs.

**Not supported by the evidence:** customer traffic, public surfaces, multi-tenant use or business delegation.

## 10. Can the existing Hetzner deployment support it without additional infrastructure or spend?

**Not as documented. A decision is needed.**

From `rkendel1/appboundry` `deploy/`:

- **The existing Hetzner server is a shared production host**: production sites, other containers and Caddy.
- **AppBoundry's path onto it is staging only** (`SHARED-HOST.md`):
  - customer execution is disabled;
  - at most **2 applications**, each **768 MiB and 1 CPU**, on loopback ports 20700–20799;
  - an aggregate slice of 3 GiB.
- **Its isolation is not customer-grade by its own account.** The agent's account is in the `docker` group, root-equivalent on a daemon shared with neighbours. Cgroup enforcement is "not demonstrated" on that host itself.
- **H0** ran one published artifact (`vote.app`) in a hardened container there, platform-owner only, with no DNS.
- The runner now pins the published `@appport/appboundry` **1.12.0** (`rkendel1/appboundry` 76aebd3), matching `packages/appboundry`; with 1.11.0 pinned, the release script's published-package path refused to build. The image itself was not built here (no Docker in this environment).

**What that means for H1:**

- Personal OS as an AppBoundry artifact could fit the staging path (one of the two slots).
- **eve and Resolver are not AppBoundry artifacts, and no documented path runs them there.** Placing them on the shared host would mean new, undocumented workloads beside production neighbours. That is additional operational risk even if it costs nothing.
- A dedicated staging host (the documented CCX13/CPX31 class) avoids that, but it is additional spend.

**Recommendation:**

1. Do prerequisite 2 first (eve CI); prerequisite 1 (the FeltKit release) is done. Neither needs infrastructure.
2. Then choose between:
   - **(a)** H1 on a dedicated staging host, the documented path, with new spend;
   - **(b)** H1 on the shared host, with eve and Resolver as new non-AppBoundry workloads. That needs an explicit risk acceptance, since it is not covered by the existing installer's guarantees.

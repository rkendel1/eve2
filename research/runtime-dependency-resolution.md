---
issue: TBD
status: proposed
last_updated: "2026-11-18"
---

# Runtime dependency resolution

> **AI status:** Written entirely by AI. Reviewed three times (2026-11-18): the direction and the
> deployment-baseline ownership (option A) are approved; the public API is under refinement (this
> revision answers the third review); the implementation is not approved. Nothing here is implemented
> in `eve`.

## Summary

A deployed eve agent names its dependencies by stable reference, such as
`ref://prod/agents/support/model`. Its operator changes what each reference points to without
rebuilding, redeploying or restarting the agent.

[Resolver](https://www.npmjs.com/package/@appport/resolver) owns the references, bindings, history,
compatibility enforcement and who may change them. eve resolves at defined boundaries, verifies each
kind's own contract, supplies the result to execution, and records a durable receipt. It never
administers Resolver.

The slice-8 audit proved the mechanics inside an example agent
(`audits/appport-foundation/CONTRACT-VERIFIED-REPLACEMENT-REPORT.md`). This proposal makes them an eve
runtime guarantee that agents consume.

## Responsibilities

| Component           | Owns                                                                                                             | Never                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Resolver            | References, bindings, revisions, history, rollback, grants; **compatibility enforcement when a binding changes** | Executes agent work; decides tool authority                    |
| Deployment operator | The dependency lifecycle: binds, replaces and rolls back with an operator key                                    | Gains an end user's application permissions                    |
| eve runtime         | Resolves at the boundaries below, verifies the kind's contract, supplies the result, records receipts            | Holds a Resolver write key; falls back to static configuration |
| Agent code          | Names each reference and what it requires of it                                                                  | Chooses or changes a binding                                   |
| AppPort             | Capability contracts and their digest algorithm (authoritative)                                                  | —                                                              |
| AuthBoundry         | Invocation authority                                                                                             | Grants anything because a dependency resolved                  |

**The principle: Resolver authority belongs to the owner of the dependency lifecycle.**

- The deployment's Resolver key is read-only: `read`, plus `reveal` only on the credentials its models
  use.
- End users never reach Resolver through the agent.

## Decisions (first review)

### 1. Who controls contracts

- **Operators control bindings.** Agents declare requirements. Resolver enforces compatibility.
- **The agent declares** each capability it requires as `name@version`.
- **The operator decides** which implementation is bound. Resolver records the exact digests that
  binding serves, and verifies them on every write and rollback, as it does today.
- **A compatible replacement needs no rebuild of the agent.**
- **A declared version stays meaningful.** A binding change must never silently move a declared
  `name@version` to a breaking contract.

**Precondition.** Today Resolver accepts a re-pin to any contract the origin serves, breaking included
(slice-8 finding). Until Resolver enforces compatibility on a binding change, an operator-controlled
digest change is **not** a safe replacement mechanism:

- **Required in Resolver:** when a binding changes the digest of a pinned `name@version`, compare the
  previous and new contracts with AppPort's `compareManifests`.
- **Breaking:** refused.
- **Compatible:** accepted, and the history records the comparison.

eve does not ship `defineAppPortDependency` as stable until that is in a Resolver release. While it is
experimental, eve holds each requirement to a deployment baseline and reports `contract_changed`
when the pinned digest moves away from it (see "Deployment baseline"). This is the conservative
stopgap; it never accepts a breaking change silently.

### 2. Receipts belong in eve's harness

A receipt is runtime evidence of what eve resolved and used. **It is not proof that the implementation
behaved correctly.** See "Receipts" below.

### 3. No change stream in version 1

**Resolution boundaries, precisely:**

| Dependency                                               | Resolves                                          | Reuses                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Model                                                    | Once per turn, before the turn's first model call | That resolution for every model call in the turn, including continuations after steering, sign-in or approval |
| AppPort implementation                                   | Once when preparing a new operation (`resolve`)   | Nothing: each new operation resolves the current binding                                                      |
| Retry, recovery, reconciliation of an existing operation | Never                                             | The operation's recorded resolution (`at`)                                                                    |

**TTL is a cache policy, not an authority policy.**

- A reference's TTL bounds how long a new resolution may be served from cache.
- It never applies to an existing operation, which never switches implementations whatever Resolver
  now says.

### 4. No new runtime dependency, and one digest algorithm

- **Resolver over HTTP.** eve calls Resolver's AppPort HTTP endpoint with `fetch`.
- **The digest is AppPort's, not eve's.** eve does not re-implement `capabilityDigest`. It vendors
  AppPort's own `canonicalize`, `digestOf` and `capabilityDigest`, generated at build from
  `@appport/protocol` at a pinned version (a `devDependency`), as eve already does for other vendored
  code. There is one source for the algorithm, and AppPort stays authoritative.
- **Shared test vectors, byte for byte:**
  - **Canonical JSON:** AppPort's existing corpus
    (`conformance/fixtures/mapping/digest-vectors.json`, RFC 8785 and SHA-256: key order, numbers,
    Unicode key order, escapes, …). The vendored code must reproduce each `canonical` string and
    `digest` exactly.
  - **Capability digests:** a new vector set, proposed for AppPort's conformance corpus. Each vector
    pairs a manifest and `name@version` with the expected `capabilityDigest`, covering:
    - with and without an integration declaration;
    - two versions of one capability;
    - a description-only change;
    - an optional and a required input field;
    - an effect change.

  eve's tests read both files from the pinned AppPort package. A vendored copy that disagrees fails the
  build.

- **Upgrades.** Upgrading the pinned AppPort version regenerates the vendored code and re-runs the
  vectors.

### 5. Tests use a real Resolver process

A locally started Resolver is not a hosted external service. A mock-only suite would not establish the
integration.

## Authoring API

Proposed as `eve/experimental/resolver`, with no compatibility promise. The two kinds share a lifecycle
and receipts, not validation. **Each has its own definition, options, result type and failure codes.**

eve connects through the deployment's environment:

- `RESOLVER_URL`: the Resolver origin.
- `RESOLVER_API_KEY`: the deployment's read key.

### Models: `resolvedModel`

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { resolvedModel } from "eve/experimental/resolver";

export default defineAgent({
  model: resolvedModel("ref://prod/agents/support/model"),
});
```

**What it resolves.** A Resolver `model` reference, built on [`defineDynamic`](../docs/dynamic-configuration/index.md),
at the model boundary above.

**Its result** is an eve model: `{ provider, model, endpoint?, credential }`.

**Its contract is model-specific:**

- Resolver's write-time checks: the provider is in the AppPort Services catalog; the credential is an
  active `secret`.
- eve's check: the provider is one eve can construct (Anthropic, OpenAI, OpenAI-compatible endpoint,
  AI Gateway).

**Credentials.** The credential material is revealed for the turn's calls, held in memory only, and
never stored in the session, a memo, a receipt or a log.

### AppPort agents: `defineAppPortDependency`

```ts title="agent/lib/catalog.ts"
import { defineAppPortDependency } from "eve/experimental/resolver";

export default defineAppPortDependency({
  ref: "ref://prod/agents/support/catalog",
  capabilities: ["catalog.reserve@1", "catalog.lookup@1"],
});
```

**The guarantees come from eve's records, not the caller's.** eve issues every resolution and keeps it
in its own records. The caller holds an identifier and nothing it can alter.

#### The resolution record

`resolve` writes the resolution record into the session's **durable state**, not its view. Views have
bounded retention; durable state survives crashes, redeploys and long sessions.

**After a redeploy, an operation resumes in the same session.** When a deployment changes, eve moves a
session to the new deployment with its ID, event stream and durable state, so `at` finds the operation's
record there.

**There is no other recovery path for a resolution.** eve has no supported path for moving an operation
into a different session, so a resolution record is never recovered from another session. The
deployment baseline store is never consulted by `at`, and is not a recovery path for resolutions.

The record is **create-only**, and nothing in the public API changes or deletes it. It holds:

| Field                               | Content                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `resolutionId`                      | eve-issued, unique                                                            |
| `operation`                         | The caller's operation identity (required; see below)                         |
| `definition`                        | The dependency's file path                                                    |
| `ref`, `revision`                   | The binding that was resolved                                                 |
| `origin`, `application`, `endpoint` | The implementation selected                                                   |
| `pins`                              | The binding's pinned `name@version → digest` at that revision                 |
| `verified`                          | The capabilities this resolution verified, with the digests the origin served |
| `receiptId`                         | The `dependency.resolved` receipt that recorded it                            |

#### `resolve(ctx, { operation, capabilities })`

**The call.** It resolves a new operation against the current binding.

- `operation` is **required**: the caller's durable identity for the operation (for example, the ledger's
  operation id), at most 200 characters.
- `capabilities` is the set the operation will use: a non-empty subset of the declared requirements.

**What it verifies,** for exactly that set:

1. Every capability in the set is pinned by the binding.
2. The origin serves each pinned digest exactly.
3. The application matches.
4. In experimental mode, no pin has moved from the deployment baseline.

Capabilities outside the set are not verified, and the record says so (`verified` lists only the set).

**Idempotent per operation.** A second `resolve` in the same session with the same `operation`
returns the first record, with a new use receipt. It does not resolve the reference again. So a caller
that mistakenly calls `resolve` on a retry or recovery still gets the implementation the operation
started on. A different `capabilities` set for an existing operation is refused (`operation_mismatch`).

**It returns** `{ resolutionId, ...a read-only copy of the record }`. The copy is for display and the
caller's own logs. eve never reads it back.

#### `at(ctx, { resolutionId, operation, capabilities })`

**The call.** It reuses an existing operation's resolution, for retry, recovery and reconciliation.

**It accepts identifiers only, never resolution fields.** eve:

1. loads the record by `resolutionId` from the **current session's** durable state, and refuses an
   unknown identifier, or one from another session (`resolution_unknown`);
2. requires `operation` to equal the record's (`operation_mismatch`);
3. requires `capabilities` to be within the record's `verified` set (`capability_not_resolved`): an
   existing operation cannot widen what was resolved for it;
4. contacts only the record's origin, and verifies each requested capability's served digest against
   the record's `verified` digests (`contract_mismatch`, `implementation_unavailable`);
5. returns the same record, with a new use receipt.

**What it never does:** read the current binding, ask Resolver, fall back, relax a check, or accept an
origin, application or digest from the caller. A tampered copy of the record in the caller's own storage
has no effect, because eve never reads it.

**Why `operation` is mandatory.** The `resolve`/`at` distinction rests on operation identity:

- It is what lets a recovered operation find its resolution after a crash.
- It is what makes an accidental `resolve` safe.

Model resolution needs no operation identity: its boundary is the turn.

## Receipts

**Each use adds one durable session fact, `dependency.resolved`.** That means each `resolve`, each `at`,
and each model resolution at a turn boundary.

| Field             | Content                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receiptId`       | Unique per receipt                                                                                                                                                        |
| `kind`            | `model` or `appport`                                                                                                                                                      |
| `definition`      | The definition that asked (file path), e.g. `agent/lib/catalog.ts`, or `agent.model`                                                                                      |
| `ref`, `revision` | The reference, and the revision that was resolved (or recorded, for `at`)                                                                                                 |
| `mode`            | `resolve` (current binding) or `at` (a recorded resolution)                                                                                                               |
| `turnId`          | The turn it was resolved in                                                                                                                                               |
| `callId`          | The tool call that asked, if any                                                                                                                                          |
| `resolutionId`    | AppPort: the resolution record used (issued by `resolve`, reused by `at`)                                                                                                 |
| `operation`       | AppPort: the caller's operation identity (required); absent for models                                                                                                    |
| `model`           | `{ provider, model, endpoint?, credentialRef, credentialRevision }`, never the credential's value                                                                         |
| `appport`         | `{ origin, application, verified }`: **only** the capabilities verified for this use, with the served digests. A receipt never implies a contract was checked that wasn't |
| `baseline`        | AppPort, experimental mode: `established` or `matched`                                                                                                                    |
| `outcome`         | `ok`, or the failure code                                                                                                                                                 |

**Properties:**

- **Durable** with the session event log; it survives restarts and deployment changes, unlike memos.
- **Readable** with an `eve/events` selector (`dependencyReceipts(view)`).
- **Reconstructible:** from a receipt and Resolver's history at `revision`, a reviewer can establish the
  exact implementation and contract used.
- **Secret-free:** no credential material, Resolver key, or authorization header.

These records and receipts are the first of two harness responsibilities; see "Harness changes".

## Failures

**Nothing falls back.** A model failure fails the turn; an AppPort failure fails `resolve` or `at`. The
codes are separate per kind.

| Kind    | Code                                        | When                                                                                                                      |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Both    | `resolver_not_configured`                   | `RESOLVER_URL` or `RESOLVER_API_KEY` unset                                                                                |
| Both    | `reference_missing` / `reference_forbidden` | Not found, revoked, or not readable by the deployment's key                                                               |
| Both    | `resolver_unavailable`                      | Resolver cannot be reached (`resolve` and models only; `at` never asks Resolver)                                          |
| Model   | `model_invalid`                             | Not a `model` reference, or a provider eve cannot construct                                                               |
| Model   | `credential_unavailable`                    | The credential cannot be revealed                                                                                         |
| AppPort | `reference_invalid`                         | Not an `agent` reference                                                                                                  |
| AppPort | `contract_not_pinned`                       | A declared `name@version` has no pin in the binding                                                                       |
| AppPort | `contract_mismatch`                         | The origin serves a different digest or application than pinned (or than recorded, for `at`)                              |
| AppPort | `contract_changed`                          | Experimental: a pin moved from the deployment baseline, without Resolver's compatibility enforcement                      |
| AppPort | `resolution_unknown`                        | `at` with an identifier eve did not issue in this session                                                                 |
| AppPort | `operation_mismatch`                        | `at` with a different operation than the record's, or `resolve` with a different capability set for an existing operation |
| AppPort | `capability_not_resolved`                   | `at` for a capability outside the record's verified set                                                                   |
| AppPort | `baseline_unavailable`                      | Experimental: the durable backend cannot provide an atomic create-if-absent for baselines                                 |
| AppPort | `implementation_unavailable`                | The resolved or recorded origin cannot be reached                                                                         |

## Deployment baseline (experimental `contract_changed`)

**What it is.** The baseline is evidence of what a deployment first successfully relied on: an
immutable fact about deployment history.

**What it is not.** It is not Resolver configuration, and not a binding revision.

**Who owns what.** Resolver stays authoritative for bindings and compatibility. eve records and enforces
its own deployment-scoped observation, as a temporary safety check, not a competing control plane.

**Definition.** For a deployment D, a reference R and a declared `name@version` C, the baseline is the
digest from the first successful `resolve` in D that verified C on R. From then on, while experimental:

| The binding's pin for C is…                                                      | Result                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Equal to the baseline (including after a rollback that restores it)              | Accepted                                                                                                                         |
| Different from the baseline, by any route: a re-pin, a replacement or a rollback | `contract_changed`. New operations needing C are refused; existing operations are unaffected, because `at` uses their own record |

**Moving a baseline.** An operator can:

- roll the binding back to the baseline digest; or
- start a new deployment, which establishes new baselines.

Nothing changes a baseline in place: no eve route, no operator action, no agent code. A store that could
be edited would become another place to decide what is compatible.

### Deployment identity

D comes from eve's **trusted runtime identity**:

- **The build deployment id.** This is the SHA-256 over the build output that `eve build` stamps into the
  build (`internal/nitro/host/build-deployment-id.ts`).
- **On Vercel,** the platform's deployment id (`VERCEL_DEPLOYMENT_ID`). This is the identity eve already
  uses to decide that a deployment changed.

**How it is protected:**

- The runtime captures D once at boot, before authored modules load, and holds it internally.
- No public API accepts it, and no operation argument, tool input or agent configuration can supply it.
- A value authored code writes to the environment afterwards is never read for it.

So an agent cannot escape a baseline by naming another deployment.

**What a change of D means.** A new build, or a new platform deployment, is a new D, with new
baselines. The same build redeployed with the same build id keeps them.

### The store

**Shape.** One record per key `(D, R, C)`, holding:

- the digest and the Resolver revision it was verified at;
- `establishedAt`;
- `establishedBy: { sessionId, resolutionId, receiptId }`.

**Operations.** The store has exactly two: **create-if-absent** and **read**. It has no update and no
delete, and it cannot change Resolver state.

**Atomicity is required, not optional.** Two sessions may make the first resolution of the same
`(D, R, C)` at once, with different digests (one before a binding change, one after):

- Exactly one create wins.
- The loser reads the record that won and compares its own verified digest against it. It never
  overwrites the record, and never proceeds as if it had established the baseline.

**Backends without it.** The store needs a backend with an atomic create-if-absent. Where a configured
durable backend cannot provide one, `defineAppPortDependency` fails closed (`baseline_unavailable`).
It does not degrade to a check that races. Which of eve's existing durable backends (the Workflow
World's local, Vercel and Postgres stores) provide it is confirmed during implementation, not assumed.

### Ordering and crash consistency

The baseline store and a session's durable state are separate stores. **eve does not provide one
transaction across them, and this design does not assume one.** It uses an ordered, idempotent
protocol instead.

`resolve(ctx, { operation, capabilities })` for a new operation:

1. **Resolve and verify, with no writes.** Read the binding, contact the origin, and verify each
   capability's served digest against the pin. Any failure ends here: **a failed resolution never
   establishes a baseline.**
2. **Settle the baseline**, for each capability in the set: create-if-absent with the verified digest.
   - `resolutionId` and `receiptId` are generated before this step, so the record can cite them.
   - If the record that exists (won by this call or another) has a different digest, the result is
     `contract_changed`, and no resolution record is written.
3. **Write the resolution record** (create-only, keyed by `operation` in the session). It carries the
   baseline outcome for each capability: `established` or `matched`.
4. **Append the receipt** (idempotent by `receiptId`).

**Recovery,** by where a crash happens:

| Crash after… | State left behind                                         | What happens next                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1            | Nothing written                                           | A retry starts again                                                                                                                                                                                                                                                                                                                                |
| 2, before 3  | A baseline citing a `resolutionId` that has no record yet | An **orphaned baseline**: still a valid fact, because it was created only after step 1 verified its digest. It is never replaced. A retry of the same operation finds it, compares (`matched` when unchanged), and writes the record. The baseline's `establishedBy` stays as written, and is read as "first verified by", not as a guaranteed link |
| 3, before 4  | A record without its receipt                              | `resolve` is idempotent per operation: a retry returns the record, and appends the receipt by its `receiptId`                                                                                                                                                                                                                                       |

### When `contract_changed` is removed

Once a Resolver release enforces compatibility on binding changes, and eve can confirm that from
Resolver's served capabilities:

- eve stops consulting and creating baselines, and the store becomes read-only history;
- it trusts a compatible binding change;
- it still verifies that the origin serves exactly the digest Resolver pins now.

Until then, `contract_changed` distinguishes "the binding moved without the compatibility guarantee"
from `contract_mismatch` ("the origin serves a digest other than the pinned one").

## Harness changes

There are two, kept separate because their lifetimes and lookup boundaries differ:

| Responsibility                                        | Scope                                    | Lifetime                        | Looked up by                                       | Written                                                |
| ----------------------------------------------------- | ---------------------------------------- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Resolution records and `dependency.resolved` receipts | Session (durable state and event stream) | The session's, across redeploys | `resolutionId` and `operation`, within the session | By `resolve` and `at`                                  |
| Baseline records                                      | Deployment `D`                           | Immutable history of D          | `(D, R, C)`                                        | Create-if-absent by `resolve` only, while experimental |

Neither can change Resolver state, and no public API edits either.

## Not in scope

- **Resolver administration in eve:** no write key, no CLI, no UI.
- **Other reference kinds:** `endpoint`, `value`, and `secret` beyond model credentials.
- **A generic contract schema across kinds.**
- **Resolver's changes,** proposed to that project: compatibility enforcement on binding changes, and
  staged (verified but inactive) bindings.
- **Hosting,** tenant-scoped delegation, and voice-agent's business-scoped tools.

## Tests

- **Build gate.** The vendored digest does not ship until AppPort publishes the capability-digest
  vectors. Canonical-JSON vectors alone do not establish capability-digest conformance.
- **Unit:**
  - each failure code;
  - requirement and pin matching;
  - the resolution boundaries (a model resolved once per turn across continuations);
  - `at` never calling Resolver;
  - the receipt schema, and no secret in any receipt;
  - the vendored digest against both vector files.
- **Integrity of resolutions.** `at` must refuse each of these before any request is sent:
  - an identifier eve never issued;
  - one issued in another session;
  - one with a different `operation`;
  - a capability outside the verified set;
  - a hand-built object in place of an identifier (a runtime type check);
  - a caller's stored copy with `origin`, `application`, `contracts` or `receiptId` altered. The test
    shows eve contacts the record's origin, not the altered one.
- **Idempotent `resolve`.** A second `resolve` with the same `operation`, after a replacement in
  Resolver, returns the original implementation.
- **Baseline:**
  - established on first use;
  - matched after a rollback to it;
  - `contract_changed` after a re-pin, with existing operations unaffected;
  - recovered after restart;
  - **concurrency:** many sessions racing the first resolution of one `(D, R, C)`, across a binding
    change. Exactly one digest wins; every loser compares against it; none overwrites it;
  - **crash points:** a crash after each step of the protocol, then recovery. The results match the
    table: no baseline from a failed resolution, an orphan never replaced, a receipt appended once;
  - **identity:** an environment change to the deployment id after boot is ignored, and no API accepts
    one;
  - **after a redeploy:** an operation resumes in the same session, and `at` uses its record.
- **Integration with a real local Resolver process:**
  - replacement without restart;
  - breaking-contract rejection, both by Resolver and by `contract_changed`;
  - operation pinning through `at` across a replacement, with retry and with recovery after a crash;
  - rollback;
  - credential isolation (key and material absent from session, receipts, logs and the store);
  - Resolver outage, for `resolve` failing and `at` unaffected;
  - receipts after restart.
- **End to end,** through the public surface only (`e2e/` fixture evals with a local Resolver process and
  a deterministic mock model): a model reference and an AppPort dependency each replaced, with
  receipts, in one agent.

## Migration

`examples/appport-agent` replaces its own resolution (`agent/lib/appport.ts`: `currentResolution`, pin
checks, endpoint discovery) with `defineAppPortDependency`. Its ledger stores each operation's `resolutionId`, and uses its own
operation id as `operation`. It calls `at` for retry, recovery and reconciliation. Its slice-8 tests become
consumer-side acceptance tests.

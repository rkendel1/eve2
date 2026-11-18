---
issue: TBD
status: proposed
last_updated: "2026-11-18"
---

# Runtime dependency resolution

> **AI status:** Written entirely by AI. Reviewed twice (2026-11-18): the direction is approved; the
> public API is under refinement (this revision answers the second review); the implementation is not
> approved. Nothing here is implemented in `eve`.

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

This is the one change inside the harness.

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
| AppPort | `implementation_unavailable`                | The resolved or recorded origin cannot be reached                                                                         |

## Deployment baseline (experimental `contract_changed`)

**Definition.** For a deployment D, a reference R and a declared `name@version` C, the **baseline** is the
digest from the first successful `resolve` in D that verified C on R. A deployment is the running eve
application at one deployment identity, so a new deployment starts new baselines. From then on, while
experimental:

| The binding's pin for C is…                                                      | Result                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Equal to the baseline (including after a rollback that restores it)              | Accepted                                                                                                                         |
| Different from the baseline, by any route: a re-pin, a replacement or a rollback | `contract_changed`. New operations needing C are refused; existing operations are unaffected, because `at` uses their own record |

**Moving a baseline.** An operator can:

- roll the binding back to the baseline digest; or
- start a new deployment, which establishes new baselines and records the previous anchor.

eve offers no route to change a baseline in place. That would make eve a control plane.

**Anchoring, the decision needed.** Resolver's history alone cannot identify D's boundary. It records
binding revisions, not which deployment first relied on which. eve has durable state per _session_, not
per deployment. Two options; neither creates an operator-maintained registry:

| Option              | Anchor                                                                                                                                                                                       | Recovery                                                                                   | Cost                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (recommended)** | A create-only _baseline receipt_ in a new, deployment-scoped durable store in eve: one record per (D, R, C), holding the digest, Resolver revision, establishing session and its `receiptId` | Read the anchor; it cites the session receipt and Resolver's revision for the full context | A small deployment-scoped store in eve, the second harness change                                                                                                                                             |
| B                   | The deployment's Resolver **consumer registration** (`register`), with the baseline in its declared dependency `contract` field (today informational, at most 200 characters, per reference) | Read the registration back from Resolver                                                   | No eve store, but the anchor lives in Resolver, written by the deployment: the agent's key would write Resolver state, and one field per reference cannot hold per-capability digests without a second lookup |

**When `contract_changed` is removed.** Once a Resolver release enforces compatibility on binding
changes, and eve can confirm that from Resolver's served capabilities:

- eve drops baselines;
- it trusts a compatible binding change;
- it still verifies that the origin serves exactly the digest Resolver pins now.

Until then, `contract_changed` distinguishes "the binding moved without the compatibility guarantee"
from `contract_mismatch` ("the origin serves a digest other than the pinned one").

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
  - recovered after restart.
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

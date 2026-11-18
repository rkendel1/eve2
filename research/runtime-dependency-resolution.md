---
issue: TBD
status: proposed
last_updated: "2026-11-18"
---

# Runtime dependency resolution

> **AI status:** Written entirely by AI. First review (2026-11-18): the direction is approved in
> principle; the public API needs refinement (this revision); the implementation is not approved.
> Nothing here is implemented in `eve`.

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
experimental, eve refuses a resolution whose served digest differs from the digest the binding pinned
when the requirement was first resolved in that deployment. It reports `contract_changed`, and an
operator must acknowledge the change in Resolver. This is the conservative stopgap; it never accepts a
breaking change silently.

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

#### `resolve(ctx): Promise<AppPortResolution>`

For a new operation, it resolves the current binding of the Resolver `agent` reference, and checks:

1. every declared `name@version` is pinned by the binding;
2. the origin serves each pinned digest exactly;
3. the served application matches the binding's.

It returns:

```ts
interface AppPortResolution {
  readonly ref: string;
  readonly revision: number;
  readonly origin: string;
  readonly application: string;
  readonly endpoint: string;
  readonly contracts: Readonly<Record<string, string>>; // "name@version" → "sha256:…", as verified
  readonly receiptId: string; // the dependency.resolved receipt for this resolution
}
```

#### `at(resolution, ctx): Promise<AppPortResolution>`

For an existing operation: retry, recovery and reconciliation.

**What it does:**

- It **consumes the recorded resolution and never resolves the reference again.**
- It contacts only `resolution.origin`, and verifies the requested capability's digest there against
  `resolution.contracts`.
- It returns the same resolution, with a new receipt for this use.

**What it never does:**

- It never reads the current binding, and never switches to a replacement, however Resolver has changed.
- It never falls back: no static URL, no current binding, no other origin.
- It never relaxes the check. A digest that differs from the recorded one, an unreachable origin, or a
  different application fails closed (`implementation_unavailable`, `contract_mismatch`).

**What the caller does on failure.** The caller's own outcome rules apply. In the example agent, an
operation never sent is failed, and one possibly sent stays indeterminate for operator settlement. There
is no blind retry.

**Why `at` takes a whole resolution.** The `AppPortResolution` value is what an operation must persist
(the example agent stores it on its ledger record). `at` accepts only that value, not a reference or an
origin string.

## Receipts

**Each use adds one durable session fact, `dependency.resolved`.** That means each `resolve`, each `at`,
and each model resolution at a turn boundary.

| Field             | Content                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `receiptId`       | Unique per receipt                                                                                   |
| `kind`            | `model` or `appport`                                                                                 |
| `definition`      | The definition that asked (file path), e.g. `agent/lib/catalog.ts`, or `agent.model`                 |
| `ref`, `revision` | The reference, and the revision that was resolved (or recorded, for `at`)                            |
| `mode`            | `resolve` (current binding) or `at` (a recorded resolution)                                          |
| `turnId`          | The turn it was resolved in                                                                          |
| `callId`          | The tool call that asked, if any                                                                     |
| `operationKey`    | Optional, from the caller (e.g. the ledger's operation id), to correlate a receipt with an operation |
| `model`           | `{ provider, model, endpoint?, credentialRef, credentialRevision }`, never the credential's value    |
| `appport`         | `{ origin, application, contracts }`: the verified digests                                           |
| `outcome`         | `ok`, or the failure code                                                                            |

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

| Kind    | Code                                        | When                                                                                                    |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Both    | `resolver_not_configured`                   | `RESOLVER_URL` or `RESOLVER_API_KEY` unset                                                              |
| Both    | `reference_missing` / `reference_forbidden` | Not found, revoked, or not readable by the deployment's key                                             |
| Both    | `resolver_unavailable`                      | Resolver cannot be reached (`resolve` and models only; `at` never asks Resolver)                        |
| Model   | `model_invalid`                             | Not a `model` reference, or a provider eve cannot construct                                             |
| Model   | `credential_unavailable`                    | The credential cannot be revealed                                                                       |
| AppPort | `reference_invalid`                         | Not an `agent` reference                                                                                |
| AppPort | `contract_not_pinned`                       | A declared `name@version` has no pin in the binding                                                     |
| AppPort | `contract_mismatch`                         | The origin serves a different digest or application than pinned (or than recorded, for `at`)            |
| AppPort | `contract_changed`                          | Experimental stopgap: the binding's pin moved without Resolver's compatibility enforcement (decision 1) |
| AppPort | `implementation_unavailable`                | The resolved or recorded origin cannot be reached                                                       |

## Still open

- **Whether `contract_changed` is needed at all.** It is not, once Resolver enforces compatibility. The
  proposal is to keep it only while experimental.
- **The first-seen digest** that `contract_changed` compares against: stored per deployment (eve's
  state) or derived from Resolver's history. The proposal derives it from Resolver's history, so eve
  stores no second copy.

## Not in scope

- **Resolver administration in eve:** no write key, no CLI, no UI.
- **Other reference kinds:** `endpoint`, `value`, and `secret` beyond model credentials.
- **A generic contract schema across kinds.**
- **Resolver's changes,** proposed to that project: compatibility enforcement on binding changes, and
  staged (verified but inactive) bindings.
- **Hosting,** tenant-scoped delegation, and voice-agent's business-scoped tools.

## Tests

- **Unit:**
  - each failure code;
  - requirement and pin matching;
  - the resolution boundaries (a model resolved once per turn across continuations);
  - `at` never calling Resolver;
  - the receipt schema, and no secret in any receipt;
  - the vendored digest against both vector files.
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
checks, endpoint discovery) with `defineAppPortDependency`. Its ledger stores the `AppPortResolution`
per operation, and calls `at` for retry, recovery and reconciliation. Its slice-8 tests become
consumer-side acceptance tests.

---
issue: TBD
status: proposed
last_updated: "2026-11-18"
---

# Runtime dependency resolution

> **AI status:** Written entirely by AI; human review pending. Nothing here is implemented in `eve`.

## Summary

A deployed eve agent should name its dependencies by stable reference, such as
`ref://prod/agents/support/model`. Its operator can then change what each reference points to without
rebuilding, redeploying or restarting the agent.

[Resolver](https://www.npmjs.com/package/@appport/resolver) owns the references, their bindings, their
history and who may change them. eve resolves them at run time and checks each against its own kind of
contract. It records what each run used, and never administers Resolver.

The slice-8 audit proved the mechanics for one dependency kind, inside an example agent
(`examples/appport-agent`, `audits/appport-foundation/CONTRACT-VERIFIED-REPLACEMENT-REPORT.md`). This
proposal moves those mechanics into eve, so agents consume them instead of implementing them.

## Responsibilities

| Component               | Owns                                                                                             | Never                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Resolver                | References, bindings, revisions, history, rollback, grants; write-time verification of each kind | Executes agent work; decides tool authority                    |
| Deployment operator     | The dependency lifecycle: binds, replaces and rolls back with an operator key                    | Gains an end user's application permissions                    |
| eve runtime             | Resolves for each use, verifies the kind's contract, supplies the result, records a receipt      | Holds a Resolver write key; falls back to static configuration |
| Agent code              | Names the references it depends on and what it requires of them                                  | Chooses or changes a binding                                   |
| AppPort and AuthBoundry | Capability contracts and invocation authority                                                    | Grant anything because a dependency resolved                   |

**The principle: Resolver authority belongs to the owner of the dependency lifecycle.**

- The deployment's Resolver key is read-only (`read`, and `reveal` only on the credentials its models
  need).
- End users never reach Resolver through the agent.

## Authoring API

Proposed as `eve/experimental/resolver`, with no compatibility promise until the review below. eve
connects through the deployment's environment:

- `RESOLVER_URL`: the Resolver origin.
- `RESOLVER_API_KEY`: the deployment's read key.

### Model references

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { resolvedModel } from "eve/experimental/resolver";

export default defineAgent({
  model: resolvedModel("ref://prod/agents/support/model"),
});
```

**How it is built.** `resolvedModel` is built on [`defineDynamic`](../docs/dynamic-configuration/index.md). It
resolves a Resolver `model` reference once per turn (a turn-keyed memo), so a change applies from the
next turn and never mixes two revisions within one.

**Its contract is model-specific:**

- Resolver's write-time checks: the provider is in the AppPort Services catalog, and the credential is
  an active `secret` reference.
- eve's own check: the provider is one eve can construct (Anthropic, OpenAI, OpenAI-compatible endpoint,
  AI Gateway).

**Credentials.** The credential's material is revealed for the call and never stored.

### AppPort agent references

```ts title="agent/lib/inventory.ts"
import { defineAppPortDependency } from "eve/experimental/resolver";

export default defineAppPortDependency({
  ref: "ref://prod/eve/inventory",
  capabilities: ["catalog.lookup@1", "catalog.reserve@1"],
});
```

```ts title="agent/tools/reserve.ts (excerpt)"
const resolution = await inventory.resolve(ctx); // fails closed; see Failures
// resolution: { ref, revision, origin, application, endpoint, contracts: { "catalog.reserve@1": "sha256:…" } }
```

**What `resolve` checks**, against a Resolver `agent` reference:

1. Every capability listed in `capabilities` is pinned by the binding.
2. The origin's served `capabilityDigest` for each one equals the pin.
3. The served application matches.

A change applies to the next `resolve`.

**In-flight work stays where it started.** A caller that has already used a resolution keeps the
`Resolution` value and passes it back: `inventory.at(resolution)` re-verifies that same implementation
and never re-resolves. That is how slice 8 kept a prepared, sent or uncertain operation on the
implementation it started against.

**The contract is AppPort's own** (`capabilityDigest`; `compareManifests` stays the consumer's rule for an
operation whose implementation changed). There is no shared contract schema across kinds.

## Receipts

Each resolution adds one session fact, `dependency.resolved`. It carries:

- the reference and revision;
- for a model: provider and model;
- for an AppPort agent: origin and each verified capability digest;
- the definition that asked for it.

**Never in the receipt:** credential material or the Resolver key.

**Why it is a session fact.** Receipts are evidence, readable with `eve/events` selectors, and they
outlive deployment changes, which memos do not. It is the one change this proposal makes inside the
harness.

## Failures

**Nothing falls back** to a static model, URL or the previous binding. Each failure fails the model call
(models) or the `resolve` (AppPort) with a code:

| Code                                        | When                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `resolver_not_configured`                   | `RESOLVER_URL` or `RESOLVER_API_KEY` unset                                |
| `reference_missing` / `reference_forbidden` | Not found, revoked, or not readable by the deployment's key               |
| `reference_invalid`                         | Not the expected kind; a provider eve cannot construct                    |
| `contract_not_pinned`                       | A required capability has no pin in the binding                           |
| `contract_mismatch`                         | The origin serves a different digest or application than the binding pins |
| `dependency_unavailable`                    | Resolver or the resolved origin cannot be reached                         |

## Decisions for review

1. **Where the contract digests live.**
   - _Proposed:_ the operator pins digests in the binding, and agent code lists only `name@version`.
     Contract evolution then needs no rebuild.
   - _Alternative:_ agent code may also pin digests, so that a contract change needs a code change.
2. **Receipts as a harness event** (above), versus leaving evidence to each agent.
3. **No change stream in the first version.** Resolve once per turn (models) or per `resolve`
   (AppPort), with the reference's TTL as the only cache. Resolver's change stream comes later.
4. **No new runtime dependency.**
   - Resolver is called over its AppPort HTTP endpoint with `fetch`.
   - `capabilityDigest` and its canonicalization are vendored from `@appport/protocol`, listed under
     `devDependencies`.
   - This follows eve's rule on wrapping third-party APIs.
5. **Experimental first.** Graduate to a stable entry after one real deployment uses both kinds.

## Not in scope

- **Resolver administration in eve:** no write key, no CLI, no UI.
- **Other reference kinds:** `endpoint`, `value`, and `secret` beyond model credentials.
- **Resolver's own gaps**, tracked in that project:
  - re-pinning to a breaking contract is accepted today;
  - verification and activation are one write, with no staged candidate.

  eve's checks do not replace those. An operator who re-pins a breaking contract changes the contract,
  and eve then verifies against it.

- **Hosting**, tenant-scoped delegation, and voice-agent's business-scoped tools.

## Tests

- **Unit:** verification, pin and requirement matching, provider mapping, failure codes.
- **Scenario:** a real Resolver process (`@appport/resolver` as a dev dependency), covering:
  - replacement without restart;
  - each failure code;
  - in-flight retention through `at(resolution)`;
  - rollback;
  - receipts after restart;
  - the deployment key's write refused.
- **End-to-end** (`e2e/` fixture evals): a deterministic mock model with a local Resolver. Whether eve's
  e2e rules ("free of external service startup") admit a local Resolver process is an open question for
  review.

## Migration

`examples/appport-agent` replaces its own resolution (`agent/lib/appport.ts`: `currentResolution`, its
pin checks and its endpoint discovery) with `defineAppPortDependency`. It keeps its operation ledger,
which stores the `Resolution` per operation and re-verifies through `at`. Its slice-8 tests become the
consumer-side acceptance tests.

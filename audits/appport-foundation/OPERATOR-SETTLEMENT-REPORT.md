# eve + AppPort: operator settlement of indeterminate operations

Branch `claude/dreamy-galileo-4z03p5`, building on `f79f3b3`. This is Slice 1 of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

**Result.** An operator authenticated by a public-key-verified token can settle an `indeterminate` operation in the existing FeltDB ledger, once, as `succeeded` or `failed`. The settlement is appended to the record with the operator's verified identity, reason and evidence, and survives eve restarts. The agent, the model and requesters cannot settle. A settled failure was not dispatched again when the model repeated the call.

## Before implementation: what existed

**How an operation becomes `indeterminate`** (`agent/lib/operations.ts`):

- AppPort answers an error that does not prove non-execution;
- an unkeyed operation is found `executing` by a process that is gone;
- reconciliation through the configured reader (`catalog.reservation`) cannot establish the outcome.

The reserve suite reaches the last case in two ways:

- the host crashes after committing the reservation, before storing its response (reconcilable once the host returns);
- the host crashes after the claim, before the effect. This one is never reconcilable, because AppPort doesn't bar abandoned keys, so "not applied" is never proven.

**Existing operator surface.** `POST /work/reconcile` admits the principal named by `APPPORT_AGENT_OPERATOR`, authenticated by `jwtHmac` with `AGENT_JWT_SECRET`. That is the **same** secret and issuer that requester tokens use. The eve process holds the secret, and so does anyone who can issue requester tokens; either can mint a token for any subject. It is fit to trigger a read-only reconciliation pass, but not to attest an outcome. Using it for settlement would have been exactly the shared-secret substitute the slice rules out.

**Mechanism chosen.** eve already ships `jwtEcdsa` (`eve/channels/auth`), which verifies ES256 tokens against a PEM public key, a fixed issuer and audiences. It is an existing, trusted host mechanism; nothing new was added to eve. The destination now uses it with:

- a public key the eve process holds only as a _public_ key (`APPPORT_AGENT_OPERATOR_PUBLIC_KEY`);
- an operator issuer distinct from the requester issuer (`APPPORT_AGENT_OPERATOR_ISSUER`);
- a dedicated audience, `appport-agent-settlement`.

No cross-repository change was needed.

## Trust boundary

| Party                                          | Can settle? | Why                                                                                             |
| ---------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| Holder of the operator private key             | Yes         | It signs ES256 tokens for the operator issuer and settlement audience                           |
| eve process, agent, model                      | No          | Holds only the public key. No tool imports settlement (tested). The model's tools are unchanged |
| The agent's AuthBoundry credential             | No          | Opaque `aga_…` token, not a JWT: 401 (tested)                                                   |
| Requesters, and the `/work/reconcile` operator | No          | HMAC tokens fail ES256 verification: 401 (tested)                                               |
| AppPort callers                                | No          | No capability exists for it (tested against the live manifest)                                  |

The recorded operator is eve's verified principal, `issuer:subject`. A body field naming an operator is rejected (400).

**What the boundary rests on:**

- **Custody of the operator private key**, outside this repository. Key distribution and rotation are deployment concerns: the variable takes one key.
- **Every verified subject is trusted.** Any subject the key signs is accepted; no per-subject allowlist is configured. eve's `subjects` option supports one if needed.
- **No replay protection beyond `exp`.** Write-once makes a replayed settlement harmless: it is refused.

**If the variables are absent**, the route answers 503 `SETTLEMENT_NOT_CONFIGURED`. There is no fallback to another credential. _Inspected, not tested._

## Ledger change and record shape

Settlement is part of the existing `appport_operations` record. There is no new store, collection or operation model.

```jsonc
{
  // … every existing field unchanged: intent, input_digest, idempotency_key,
  // attempts, request_ids, outcome (AppPort's last answer), resolution, reconciliations
  "state": "failed", // was "indeterminate"
  "settlement": {
    "at": "2026-11-18T…Z",
    "operator": "https://operators.example:dana",
    "outcome": "failed",
    "reason": "The host died after claiming the key and before reserving.",
    "evidence": "catalog.reservation: not_applied, BETA-2 stock unchanged at 7",
    "prior_state": "indeterminate",
  },
}
```

**The write.** One `updateIfVersion` that sets only `state` and `settlement`, conditional on the version that was read while it was `indeterminate`. A concurrent settlement or reconciliation loses the compare-and-set: the settlement path re-reads and refuses, and the reconciliation path throws, as it did before.

**Other code changes:**

| File                            | Change                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/lib/operations.ts`       | `settleOperation`: validation, the state and write-once checks, the conditional write. `decideOutcome` appends `; N settled by an operator`, and the `indeterminate:` decision now names its operation ids, so an operator can find them |
| `agent/channels/work.ts`        | `POST /operations/:operationId/settle`: operator auth, a 4 KiB body cap, then re-decides the work through the existing `reconcileWork`                                                                                                   |
| `agent/tools/appport_invoke.ts` | A repeated call on a settled operation returns the attestation (`OPERATION_SETTLED_FAILED`, or success with `settledByOperator`) instead of an AppPort output that never existed                                                         |
| `agent/lib/work.ts`             | `GET /work` shows `settlement`; `ok` is derived from `state` (identical for unsettled operations)                                                                                                                                        |

## Settlement and reconciliation semantics

| Situation                                                                                                               | Behavior                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Operation not `indeterminate` (`prepared`, `executing`, `succeeded`, `failed`)                                          | 409, nothing written                                                                                                          |
| Already settled                                                                                                         | 409, including an identical repeat                                                                                            |
| Malformed: not JSON, not an object, unknown field, bad outcome, empty or multi-line reason or evidence, over the limits | 400                                                                                                                           |
| Unknown operation                                                                                                       | 404                                                                                                                           |
| Settled `succeeded`                                                                                                     | Work re-decided. With no other open operations, it completes                                                                  |
| Settled `failed`                                                                                                        | Work re-decided. It stays `blocked` (nothing took effect), but is no longer indeterminate                                     |
| Later model call with the same operation id                                                                             | Returned from the ledger; nothing sent. This path already short-circuited on `succeeded`/`failed` before any dispatch         |
| Later reconciliation                                                                                                    | `reconcileOperation` acts only on `indeterminate` or stale `executing`, so it neither touches nor queries a settled operation |

**Differences from Stack-Agent SA-20.**

- **A settled failure is final.** Stack-Agent lets an intent settled as "not executed" be performed again by the normal path (its test `an_effect_settled_as_not_executed_is_performed_by_the_normal_path`). This slice requires the opposite: a new attempt needs a new operation.
- **Mechanisms not ported.** Stack-Agent's lease acquisition and its "refuse while the intent has an observation" rule are not ported. Here an `indeterminate` operation has no running executor by construction, and the compare-and-set covers races.
- **Kept from Stack-Agent:** settlement performs nothing, invents no receipt, preserves history, records who and on what evidence, and is write-once.

## Evidence

All tests were run in this environment, with Node 26, on this commit.

| Command                                                           | Result                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit -p tsconfig.json`                               | Clean                                                                                                                                                  |
| `node --test --test-reporter=spec test/settle.test.mjs`           | **11 of 11**                                                                                                                                           |
| `node --test --test-reporter=spec test/` (full destination suite) | **84 of 84** passed. The real-model `describe` in `acceptance.test.mjs` was **skipped**: no Anthropic key in this environment. Those tests did not run |

`test/settle.test.mjs` runs real `eve start` with the scripted model, the AppPort host as its own process, AuthBoundry and FeltDB on disk. It stops eve's process group to read FeltDB directly.

| #   | Requirement                                      | Observed                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Settle a real indeterminate reserve as succeeded | Host killed after committing ALPHA-1 × 3: work `blocked`, `indeterminate`. The operator reads `catalog.reservation` (present) and settles as succeeded → 201; work `completed`, decision `…; 1 settled by an operator`; stock unchanged (39)                                                                                      |
| 2   | Settle as failed                                 | Host killed after the claim (BETA-2 × 1). Two reconcile passes keep it indeterminate (≥ 3 reconciliations, all `indeterminate`). Settled as failed → work `blocked`, `waiting: …; 1 settled by an operator`; stock unchanged (7)                                                                                                  |
| 3   | Second settlement rejected                       | An identical repeat → 409 "already settled as failed"; a different operator flipping to succeeded → 409; the record keeps the first operator                                                                                                                                                                                      |
| 4   | Non-indeterminate rejected                       | A normal succeeded reservation → 409; its record has no settlement. Unknown id → 404                                                                                                                                                                                                                                              |
| 5   | Agent credential rejected                        | 401 for: the agent's AuthBoundry credential, Alice's token, the HMAC `/work/reconcile` operator token, another EC key, the wrong audience, the wrong issuer, an expired token, no token. The ledger record is deep-equal before and after                                                                                         |
| 6   | No tool or capability                            | The tools directory holds only the three AppPort tools, and none references `settleOperation`; only `channels/work.ts` imports it; no live capability name contains `settle`                                                                                                                                                      |
| 7   | Survives an eve restart                          | After the restart and a reconcile pass, the work is still `completed`, the settlement is equal to the one written, a new settlement gets 409, and stock is unchanged                                                                                                                                                              |
| 8   | Record contents                                  | Exact `settlement` object (verified `issuer:subject`, reason, evidence, outcome, `prior_state`, time). Sixteen pre-existing fields are deep-equal to the pre-settlement record, including all `reconciliations`                                                                                                                   |
| 9   | No redispatch                                    | A new turn in the same eve session makes the model call `catalog.reserve` with the same input again. A new call link points at the same operation; host provenance shows **no** new `catalog.reserve` request for the work; `attempts`, `request_ids` and `reconciliations` are unchanged. A further reconcile pass sends nothing |
| 10  | Completion                                       | Before settlement, both works are `blocked` with `indeterminate:` decisions; neither reported success. After settlement they reflect the settled outcome (#1, #2)                                                                                                                                                                 |

Malformed bodies get 400, covering: non-JSON, an array, a missing outcome, reason or evidence, an invalid outcome, a blank reason, multi-line evidence, oversize evidence, and an `operator` field.

**Mutation checks.** Each mutation was applied to the source, the settle suite was run, and the file was restored. All were caught.

| Mutation                                       | Caught by                                            |
| ---------------------------------------------- | ---------------------------------------------------- |
| Route also accepts the requester HMAC verifier | Credential refusal (plus 3 cascades)                 |
| State check removed                            | Non-indeterminate refusal                            |
| Settlement recorded without changing `state`   | Completion, redispatch, history, write-once, restart |
| Ledger dispatches a settled failure again      | No redispatch (alone)                                |
| Settlement clears reconciliation history       | History, redispatch, restart                         |
| Write-once check removed                       | Write-once, restart                                  |

## Limitations and prerequisites

- **Operator key custody** is outside the example: one public key, no rotation list. The route is disabled (503) when it isn't configured.
- **No subject allowlist.** Any subject the key signs is an operator.
- **Finding operations to settle.** An operator learns ids from `indeterminate:` decisions (the `/work/reconcile` response or the work record). There is no listing route; none was added.
- **Settlement is an attestation, not proof.** A wrong attestation is recorded as given. The record makes it attributable, but not correctable: write-once forbids a second settlement, by design. Correcting an operator's mistake would need a separate, explicitly designed record and was not built.
- **A settled `succeeded` carries no AppPort output.** A model asking again gets the attestation, not the reservation details.
- **`/work/reconcile` still uses the shared HMAC secret.** It only triggers reads and was left as is (out of scope). Moving it to the operator key would be a small follow-up.
- **Not run:** the real-model acceptance tests (no key here).

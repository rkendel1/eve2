# eve AppPort agent: durable AppPort idempotency

Branch `claude/dreamy-galileo-4z03p5`, building on `1819c69`.

The problem: eve's operation ledger reuses an operation id as AppPort's idempotency key, but the AppPort host kept keys in AppPort's `MemoryIdempotencyStore`. A host restart forgot that a key had already executed.

The fix is a FeltDB-backed implementation of AppPort's existing `IdempotencyStore` interface, injected through `createApplication({ idempotency })`. AppPort's runtime is unchanged.

| Part                                 | Size                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `appport-host/idempotency-store.mjs` | About 130 lines                                                                  |
| Host wiring                          | 10 lines                                                                         |
| eve ledger change                    | 1 classification: `IDEMPOTENCY_KEY_REUSED` → `failed` (refused, so not executed) |

## Phase 1: the contract, as implemented in `@appport/core` 1.8.0

The runtime path (`application.js`, request handling) goes like this:

1. Input is validated, **authorization is decided**, and the key is scoped to `<session or principal>|<capability>@<version>|<key>`.
2. `get(key)` is called. A **completed** record that matches (capability, version, session, principal, request digest) is replayed. A mismatch is `CONFLICT` / `IDEMPOTENCY_KEY_REUSED`.
3. Concurrent identical requests **in one process** share one execution (`#inflightIdempotent`).
4. `claim(entry)` is called. It must be atomic create-if-absent. If an entry exists, a matching **claim** answers `CONFLICT` / `IDEMPOTENCY_OUTCOME_UNKNOWN` (with the original `requestId`), and a matching record is replayed.
5. The handler runs.
6. On success, `set(record)` replaces the claim with the completed response.
7. If the handler threw, or never started, `release` is called: AppPort treats a throwing handler as having had no effect.
8. Otherwise (timeout, cancellation, output validation, or a failed `set`) **the claim is kept**.

**Crash windows** with a store that persists claims:

| Process dies…                                   | Durable state left  | Repeated request                      |
| ----------------------------------------------- | ------------------- | ------------------------------------- |
| Before `claim` is written                       | Nothing             | Executes; nothing had executed before |
| After `claim`, before or while the handler runs | `in-progress` claim | `OUTCOME_UNKNOWN`; not executed       |
| After the handler's effect, before `set`        | `in-progress` claim | `OUTCOME_UNKNOWN`; not executed       |
| After `set`                                     | `completed` record  | Replayed                              |

Persisting only completed responses would leave rows 2 and 3 indistinguishable from "never claimed", so the claim must be durable.

**Liveness.** AppPort answers a live claim and an abandoned claim the same way (`OUTCOME_UNKNOWN`). The store records the host instance that wrote each claim (`owner`), so a person can tell them apart, but the runtime does not.

**Expiry.** AppPort's interface comment says an expired entry counts as absent (24-hour TTL). Honoring that would make an abandoned claim **executable again after 24 hours**. This store deliberately never expires records, and that is the one deviation.

## Phase 2: the store

| Requirement                                         | Implementation                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claim persisted before execution                    | `claim`: FeltDB `insert(..., { requireAbsent: true })`, committed before AppPort runs the handler                                                                                    |
| Consistent key scope                                | AppPort's scoped key. The host now derives one AppPort session per (agent, person)                                                                                                   |
| Capability and request fingerprint                  | Stores `capability`, `version` and AppPort's `requestDigest`, and returns them on read so AppPort's matcher can compare                                                              |
| Reuse with different content rejected               | AppPort's matcher, which depends on the store returning the digest (mutation-tested)                                                                                                 |
| Completed responses persisted                       | `set`: compare-and-set on the claim of the same `requestId`; another request's entry is never overwritten                                                                            |
| No independent concurrent execution                 | One process: AppPort's in-flight map, then the conditional insert. Across processes: FeltDB's exclusive lock allows **one host per store**                                           |
| Completed / in-progress / interrupted distinguished | `status` (`in-progress`, `completed` or `released`) plus `owner`. "Interrupted" is an `in-progress` record whose owner is no longer running; AppPort reports it as `OUTCOME_UNKNOWN` |
| Survives restarts                                   | FeltDB local file runtime in `<APPPORT_HOST_DATA_DIR>/idempotency`                                                                                                                   |

No process-local lock is used for correctness. Concurrent `claim` calls are decided by FeltDB's create-if-absent: 10 concurrent claims gave exactly 1 `"claimed"`.

## Phase 4: evidence

**Restart method.** The host runs as its own process (`test/probe-host.mjs`) with a file-backed effect counter, so effects are visible outside the process. Each restart test does the following:

1. Kills the host's process group and the AuthBoundry group (orphaned by the known `@authboundry/local` defect), and checks both are gone.
2. Opens the host's FeltDB store directly and inspects the records.
3. Starts a **new process** on the same data directory, which gets a new `owner`.

| #   | Requirement                                  | Test                                                                                             | Observed                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claim persisted before execution             | `persists the claim before execution…`                                                           | Host killed inside `claim`: the record is `in-progress`, owned by the dead host, with the request's id; **0 effects**                                                                                                                                                                                                     |
| 2   | Completed invocation replays                 | `replays a completed response…`                                                                  | Second call replayed; 1 effect                                                                                                                                                                                                                                                                                            |
| 3   | Same key, changed input                      | `rejects the same key with different input…`                                                     | `IDEMPOTENCY_KEY_REUSED` after a restart; 0 effects for the new input                                                                                                                                                                                                                                                     |
| 4   | Concurrent same key                          | `executes concurrent requests…`, `decides concurrent claims…`, `refuses to start a second host…` | 5 concurrent requests → 1 effect, all `applied: 1`. 10 concurrent store claims → 1 claimed. A second host on the store fails with `STATE_LOCKED` before starting AuthBoundry                                                                                                                                              |
| 5   | Restart preserves completed records          | `replays a completed response…`                                                                  | After a real restart: replayed (`idempotentReplay: true`), same output, still 1 effect                                                                                                                                                                                                                                    |
| 6   | Restart after the claim, before execution    | `persists the claim…`                                                                            | Retries get `OUTCOME_UNKNOWN` naming the original request id; 0 effects                                                                                                                                                                                                                                                   |
| 7   | Restart after the effect, before persistence | `never repeats an effect…`                                                                       | Host killed in `set` after the handler's effect: 1 effect; the retry after restart gets `OUTCOME_UNKNOWN`; **still 1 effect**                                                                                                                                                                                             |
| 8   | Interrupted operations are uncertain         | Tests 6 and 7                                                                                    | `in-progress`, never reported as success or failure                                                                                                                                                                                                                                                                       |
| 9   | Uncertainty kept across repeats and restarts | `keeps an interrupted claim uncertain…`                                                          | Two retries, another restart, another retry: the record is unchanged (version 1); 0 effects                                                                                                                                                                                                                               |
| 10  | eve ledger correlates with AppPort records   | `replays an effect from the durable store when eve and the host both restart`                    | eve crashed after the effect, **then the host was restarted**, then eve. The ledger re-sent with the same key; the durable store replayed it (1 effect). `operation.idempotency_key` names the scoped store key; the store record's `requestId` is the first AppPort request; the ledger's `request_ids` holds the replay |
| 11  | Requester and agent isolation                | `scopes keys to the person…`, `writes no claim for a caller…`                                    | Bob's request with Alice's key and input ran as his own (`applied: 2`), not Alice's replayed response. A forged agent credential got `UNAUTHORIZED` and wrote no record                                                                                                                                                   |
| 12  | Earlier suites                               | All                                                                                              | Green                                                                                                                                                                                                                                                                                                                     |

**Runs:**

- The idempotency suite passed 11 of 11.
- The full suite passed 54 of 54 with the real Anthropic model: four files, concurrently.
- The key appeared 0 times in the logs, and no processes were left running.

**Mutation checks**, each on the idempotency suite:

| Mutation                                               | Targeted test caught it                           | Total failures |
| ------------------------------------------------------ | ------------------------------------------------- | -------------- |
| Completed-record lookup removed (in `get` and `claim`) | Restart replay; the eve and host restart test     | 4              |
| Abandoned `in-progress` claim allowed to execute       | Claim-before-execution; effect-before-persistence | 8 (cascade)    |
| Request digest not returned                            | Key reuse with changed input, only                | 1              |

## Required distinctions

| Question                                            | Answer                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which records are durable, and where                | The `idempotency` collection of a FeltDB local file store at `<APPPORT_HOST_DATA_DIR>/idempotency`, one record per scoped key. eve's operation ledger is a separate FeltDB store, in eve's work directory                                         |
| Are claims and responses transactionally persisted? | Each is its own atomic FeltDB write: a create-if-absent claim, then a compare-and-set completion. **The capability's effect is not in either transaction.** That gap is the "after the effect, before the response" window, which stays uncertain |
| Host dies before execution                          | Before the claim: nothing recorded, and a retry executes (correct, since nothing ran). After the claim: `OUTCOME_UNKNOWN` forever, which is conservative, because whether the handler started is unknown (observed)                               |
| Host dies after the effect, before the response     | `OUTCOME_UNKNOWN`; never executed again (observed: 1 effect)                                                                                                                                                                                      |
| Two hosts, same key                                 | Cannot happen on one store: the second host is refused (`STATE_LOCKED`, observed). Two hosts with **separate** stores have no shared idempotency (inferred; not supported)                                                                        |
| What depends on capability-level idempotency        | Turning "sent again" into "ran once" requires `idempotency: "supported"`. A throwing handler is **released** and runs again on retry; that is safe only if the capability's own effects are atomic with its success                               |
| Tested across an actual host restart?               | Yes: a new process on the same store, after the old process group was confirmed gone                                                                                                                                                              |
| What still needs a person                           | Every `in-progress` record left by a dead host, and the eve operation it maps to (`indeterminate`)                                                                                                                                                |

## Observed versus inferred

**Observed:** everything in the evidence table, with real host processes, a real FeltDB store, the real AppPort HTTP path and runtime, real AuthBoundry, and real eve with a scripted model.

**Inferred, not tested:**

- behavior on FeltDB runtimes other than the local file runtime;
- disk failures inside FeltDB's commit;
- hosts sharing a managed FeltDB server, which would need FeltDB's server runtime and is not used here;
- effects of real external systems.

**Not claimed:** exactly-once external effects. The handler runs at most once per scoped key, as long as its record survives. Whether an external system applied an effect exactly once depends on that system.

## Remaining gaps

- **No resolution path for uncertain operations** (the next milestone). There is no way to mark an `in-progress` record or an `indeterminate` operation succeeded or failed after inspection.
- **No retention policy.** Records never expire.
- **One host per store.** Horizontal AppPort hosts need a shared authority, such as FeltDB's server runtime, and are not covered.
- **The known AuthBoundry orphan defect** still affects host crashes. Tests clean the orphan up explicitly; production needs control-group supervision.

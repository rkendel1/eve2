---
issue: "none: EVE on FeltDB milestone, Phase A and A.2 (no tracking issue yet)"
status: proposed
last_updated: "2026-11-26"
---

# A FeltDB Workflow World for eve (Phase A.2: contract, design and capacity review)

Goal: eve runs its complete lifecycle on FeltDB, with no FeltKit, through a Workflow **World** implemented over
FeltDB's supported public API, beside the existing Postgres World (which stays the reference). This document maps
every World operation eve uses to the Postgres implementation and to a FeltDB primitive, states the invariants
and how each is held, and lists the decisions needed before implementation.

Sources (checked at the commits below; `W` = `@workflow/world@5.2.2/dist`, `PG` = `@workflow/world-postgres@5.3.0/dist`,
`CORE` = `@workflow/core@5.6.1/dist` (the version eve pins, `packages/eve/package.json:698`), `FDB` = `flow_db`
repository, eve paths relative to `packages/eve`):

| Repository       | Commit                               | Note                                                                                                                 |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| eve2             | `ab46131` (main; contains `a88c765`) | `eve` 1.1.0 = published `@appport/eve` 1.1.0, plus an unreleased license fix; resolves `@workflow/world-local` 5.4.1 |
| flow_db (FeltDB) | `bc6343a3` (main)                    | `@feltdb/core` 0.23.0 = published                                                                                    |

## 1. What eve requires of a World

eve validates a World (`src/internal/workflow/validate-world.ts:54-65`: `createQueueHandler`, `events`, numeric
`specVersion`), pins the World package to its `@workflow/world` major (`validate-world.ts:27-51`), and defaults to
**spec 9** (`src/internal/workflow/spec-version-default.ts:1-8`).

**Capabilities.**

- `atomicStartHook.active` is **hard-required**: eve refuses to start a session without it
  (`src/internal/workflow/start-claim.ts:3-8`).
- `inBandFence` is required for spec 9 runs (`CORE/runtime/start.js:452,684`, `CORE/runtime/spec9/in-band-writer.js:190`).
- `hookRetention.active` is checked with `atomicStartHook` (`CORE/runtime/start.js:315-319`).
- `hookResumeDedup` and `resolvedHookResume` are used when present.
- `maxConcurrency` (one orchestrator delivery per run) is optional in name but expected by spec 9 delivery.

**Members called on normal paths:**

- `events.create`, `events.list` (it must return a `{seq, seqInBand}` snapshot), `events.get`, `events.listByCorrelationId`
- `runs.get`, `runs.list`, `runs.experimentalSetAttributes`
- `hooks.getByToken`, `hooks.get`, `hooks.list`
- `steps.get`, `steps.list`
- `streams.write`, `writeMulti`, `close`, `get`, `getChunks`, `getInfo` and `list`
- `queue`, `createQueueHandler`, `registerHandler` (in-process delivery, `src/internal/nitro/host/route-handlers.ts:174-175`)
- `getDeploymentId`, `start`, `close`

**Optional members, probed:**

- `events.createBatch`, `events.subscribe`, `queueBatch`
- `runs.cancelMany`, `runs.waitForTerminalStatus`
- `createRunId`, `getEncryptionKeyForRun`
- `invoke`, which is used only when `capabilities.invoke` is set

**Installation.** `experimental.workflow.world` names a package. eve calls its `createWorld()` (or its default
export) with **no arguments**, so configuration comes from the environment (`CORE/runtime/world.js:47-58`,
`src/internal/application/compiled-artifacts.ts:277-363`). eve then calls `start()` (`install-workflow-world.ts:10-17`),
and calls `close()` with a 5 s limit on shutdown (`runtime-plugin.ts:24,37`).

**Delivery.** With an explicitly configured World, `eve start` delivers in-process through `registerHandler` (`host-routes.ts:173-178`).
No HTTP self-callback is needed.

**Other state.** Memory is a separate, pluggable backend (section 6). Attachments are staged inside the session
sandbox, not on the host (`src/harness/attachment-staging.ts:36,561-563`). Dynamic schedules are runs and hooks in the
World (`src/public/schedules/providers/workflow.ts:224-233`). Nothing else on the host is authoritative except
`~/.eve/auth` and `.eve/provider.json` (credentials and settings: outside this milestone).

## 2. FeltDB as a substrate: what it guarantees (verified)

| Property                                          | FeltDB 0.23                                                                                                                                                                                      | Source                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Atomic multi-record, multi-collection transaction | yes, one journal record                                                                                                                                                                          | `FDB/packages/core/src/file-db.ts:1277-1353`                                                                  |
| Reads inside a transaction                        | **none**: the callback only stages writes; no snapshot isolation, no read tracking                                                                                                               | `FDB/public-docs/guarantees.md:104-115`                                                                       |
| Commit-time validation                            | only explicit predicates: `requireAbsent`, `ifVersion`, `expectedEpoch`, `expectedLeaseId`, experimental read-basis fences                                                                       | `FDB/packages/core/src/embedded-transaction.ts:421-497`                                                       |
| Versioning                                        | a guarded write stores N+1; **an unguarded write stores `__version` verbatim** and delete+recreate restarts at 1 (ABA)                                                                           | `FDB/docs/architecture/transaction-version-contract.md:66-73,188-192`                                         |
| Conflict                                          | `ConditionalConflictError`, `PRECONDITION_FAILED`, with the failed predicate                                                                                                                     | `FDB/docs/reference/public-api.md:251-267`                                                                    |
| Idempotent transaction ids                        | same id and payload returns the original result; a different payload is `IDEMPOTENCY_CONFLICT`. **Committed transaction ids are never removed**, not even by `compact` (measured in section 7.2) | `FDB/public-docs/guarantees.md:118-155`; `FDB/docs/reference/embedded-state-lifecycle.md:140`                 |
| Record ids                                        | `^[A-Za-z0-9._-]{1,128}$` for collection names and ids: `:` and arbitrary user strings (hook tokens, idempotency keys) must be encoded, by SHA-256 hex or base64url                              | `FDB/packages/core/src/embedded-transaction.ts:99` (measured: `wf_events/run:1` is refused `INVALID_REQUEST`) |
| Durability (file runtime)                         | each commit fdatasynced before acknowledgement (no group commit); SIGKILL tested; power loss **unproven**                                                                                        | `FDB/docs/reference/durability.md:48-49,198-206`                                                              |
| Multiple processes                                | file runtime is exclusive by default (`STATE_LOCKED`); `access:'shared'` is Experimental, polls a lock for up to about 5 s and then throws an untyped `Error`; multi-host needs the server       | `FDB/packages/core/src/file-db.ts:1186-1271`                                                                  |
| Queries                                           | bounded `db.query` (where, orderBy, limit 1-1000, keyset cursor); ordered compound indexes on embedded runtimes; **the server has equality indexes only**                                        | `FDB/docs/reference/bounded-authority-query.md:56-64,155-158`                                                 |
| Change notification                               | `db.onCommit` (Experimental): in-process only on embedded runtimes; at-most-once over SSE on the server; no durable cursor                                                                       | `FDB/packages/core/src/embedded-features.ts:258-316`; `http-db.ts:1324-1415`                                  |
| Queue or work primitive                           | `db.workloads` (Durable Work): Experimental, **server only**, no claim-next                                                                                                                      | `FDB/packages/core/src/workload.ts:51-63`                                                                     |
| **Residency**                                     | **every runtime holds all rows in process memory** (file runtime `this.state.rows`; Rust authority `rows: HashMap`) plus a journal and checkpoints                                               | `FDB/packages/core/src/file-db.ts:603-632`; `FDB/crates/feltdb/src/lib.rs:698`                                |
| API status                                        | Stable: `createFeltDB`, collections, transactions, CAS, bounded `db.query`, `db.snapshot`. Experimental: `onCommit`, expiry, file ownership (`access`), Durable Work, content store, agent state | `FDB/docs/reference/public-api.md:486-519`                                                                    |

What this means for the World: every World decision has to be expressible as predicates on records **keyed by what
must be unique**. Postgres can lock a row and read inside the transaction; FeltDB cannot. Section 3 shows each
decision can be expressed this way.

## 3. Operation map

For each row: the contract (`W`/`CORE`), the Postgres behavior (`PG`), the FeltDB mechanism, compatibility, failure
behavior, and the test that will prove it. "Run head" is one record per run, `wf_runs/<runId>`, always written with
`ifVersion` (never unguarded: see section 2).

### 3.1 Events and positions (`events.create`)

**Contract.** Each event is appended at the run's next 1-based position, as `evnt_<padded slot>`, with no gaps and no
duplicates (`W/interfaces.d.ts:259-285`).

- Spec 9 in-band writes carry `expectedSeqInBand`. A stale value is refused with `InBandSupersededError` (412),
  and nothing is assigned.
- An in-band `createdAt` must equal the `occurredAt` it was sent with.
- The run, step, hook and wait view rows change in the same write.

**Postgres.**

- The next slot is computed as `max(id)+1` inside the insert. On conflict the insert does nothing and is retried:
  8 immediate retries, then backoff, then a 503 after 40 attempts (`PG/storage.js:22-39,87-92,266-310`).
- Transactions are READ COMMITTED with `SELECT … FOR UPDATE` on the rows each decision depends on (`PG/storage.js:54`).
- The fence is a guarded `UPDATE … SET seq_in_band+1 WHERE seq_in_band=$expected` in the same CTE as the insert
  (`PG/storage.js:214-252,825-896`).
- Postgres honors `occurredAt` only on the fenced path (`:225,882-889`).
- **Validation reads for unfenced writes happen outside the write transaction**, and some event types are a single
  bare insert (`PG/storage.js:1092,1300,2710`).

**FeltDB.**

1. Read the run head (`seq`, `seqInBand`, `status`, `__version`) and any view records the event needs.
2. Decide in code.
3. Commit one transaction:
   - the run head with `ifVersion` (`seq+1`, plus `seqInBand+1` if in-band);
   - the event `wf_events/<runId>.<slot>` with `requireAbsent`;
   - the view records with `ifVersion` or `requireAbsent`.
4. On `PRECONDITION_FAILED` on the head, re-read and retry. For an in-band write, if `seqInBand` changed, throw
   `InBandSupersededError` and assign nothing.

**Compatibility: exact, and stronger than Postgres.**

- Every decision is fenced by the run head's version, so no validation runs outside the commit.
- Positions come from the head counter written in the same transaction as the event, so a gap or a duplicate
  cannot commit.
- A taken position cannot occur: the head serializes writers. A contending writer re-reads and moves to the
  next slot, reporting skipped events as the contract allows.

**Failure.**

- A crash before commit writes nothing.
- A crash after commit is durable: one fdatasync.
- A lost acknowledgement on the server is `COMMIT_OUTCOME_UNKNOWN`. Retrying with the same transaction id returns the
  original result, so the transaction id is derived from the event's identity (run, correlation, type, and
  `expectedSeqInBand` or a client nonce).
- Heavy contention on one run serializes through the head, which is the same per-run serialization Postgres
  gets from its locks. Retries are bounded, then a 503 as in Postgres.

**Verification.**

- Workflow's `inBandFenceConformance`.
- N concurrent writers on one run: positions are 1..N with no gaps.
- A stale `expectedSeqInBand` assigns nothing.
- SIGKILL during the append, then a fresh process: the log is contiguous and the head agrees with the last event.

### 3.2 Views and the event state machine

The run, step, hook and wait records (`wf_runs`, `wf_steps`, `wf_hooks`, `wf_waits`) change with their event in
the one transaction above. Postgres's per-event-type transactions (`PG/storage.js:1392-2705`) map one-to-one:

| Event               | Records in the same transaction                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_created`       | head (`requireAbsent`), start-hook admission record `wf_admissions/<runId>` (`requireAbsent`, which makes atomic start-hook admission one commit), first event |
| `run_started`       | head guarded transition                                                                                                                                        |
| terminal run events | head, then deletion of waits and of hooks whose retention ended, each delete guarded by `ifVersion`                                                            |
| `step_*`            | `wf_steps/<runId>.<stepId>` (`requireAbsent` on create; `ifVersion` on transitions)                                                                            |
| `wait_*`            | `wf_waits/<runId>.<correlationId>`                                                                                                                             |
| `hook_created`      | `wf_hooks/<hookId>` plus token claim `wf_hook_tokens/<sha256(token)>` (`requireAbsent`: global token uniqueness)                                               |
| `hook_received`     | resume record `wf_hook_resumes/<runId>.<resumeId>` (`requireAbsent`: dedupe), under the run head                                                               |
| `hook_disposed`     | delete hook and token claim (`ifVersion`)                                                                                                                      |
| force claim         | victim's `hook_disposed`, delete victim hook, move the token claim (`ifVersion`), claimer's hook: one transaction over two run heads                           |

Entity uniqueness, which Postgres enforces with a partial unique index (`PG/schema.js:146,156`), becomes
`wf_entities/<runId>.<correlationId>.<type>` with `requireAbsent`.

**Compatibility: exact.** Every Postgres uniqueness constraint has a record keyed by its columns.

**Reads.**

- `runs.list`, `steps.list`, `hooks.list` and `events.list` use bounded `db.query` with keyset cursors on ordered
  compound indexes (embedded).
- `events.list` returns the head's `{seq, seqInBand}` read **before** the list, as Postgres does (`PG/storage.js:905-948`).

**Verification.** A replay of each event type against both Worlds compares the resulting view records. Workflow
also ships `DUPLICATE_EVENT_FIXTURES`.

### 3.3 Hooks

The token claim and the resume dedupe are covered above.

- **Retention:** each hook records `retainUntil`; reads filter by it. Expiry is enforced by deletes in terminal-run
  transactions and by the maintenance pass (3.6), not by FeltDB expiry, which is Experimental and embedded-only.
- **Force claim:** one transaction, guarded on both run heads.

**Compatibility: exact.** **Verification:** `atomicStartHookConformance`, a concurrent token claim (exactly one
wins), duplicate `hook_received` with the same `resumeId` (one event), and a force claim racing a resume.

### 3.4 Queue

**Contract** (`W/queue.d.ts:834-1008`):

- `queue(name, payload, {delaySeconds, idempotencyKey, retentionSeconds})` returns a `messageId`.
- The handler built with `createQueueHandler` (in-process through `registerHandler`) returns:
  - `{timeoutSeconds:n>0}`: redeliver the same `messageId` with the next `deliveryCount` after n seconds;
  - `{timeoutSeconds:0}`: a handoff, redelivered immediately and not counted;
  - a rejected handler: retry with backoff;
  - anything else: acknowledge.
- `messageId` is stable across redeliveries; `deliveryCount` strictly increases and is never 1 on a redelivery.
- Keyed sends are deduplicated while the message lives.
- Spec 9 serializes orchestrator deliveries per run.

**Postgres** (`PG/queue.js`):

- graphile-worker jobs. The job key is `idempotencyKey ?? messageId`, plus a per-process LRU.
- `retentionSeconds` is **not implemented**.
- Polls every 500 ms.
- Default concurrency 50.
- A per-run delivery lease exists only for spec 9 orchestrator and invoke messages.
- **After a worker crash, step messages and spec 8 runs can stay locked for up to 4 hours** unless `jobLockStaleSeconds` is set
  (`PG/job-lease.js:80-173`).

**FeltDB: a World-specific queue on records.** `db.workloads` is server-only and has no claim-next, so it cannot
serve; the gap is recorded in section 8. Records:

- `wf_messages/<messageId>`: `{queue, payload, runId?, visibleAt, deliveryCount, offset, state: ready|leased, leaseOwner, leaseUntil, createdAt, retainUntil}`
- `wf_message_keys/<sha256(queue, idempotencyKey)>`: `requireAbsent` gives the dedupe; the record is deleted when its message is acknowledged
- `wf_run_delivery/<runId>`: the per-run orchestrator lease

Operations:

- **Publish:** one transaction: message (`requireAbsent`) plus key (`requireAbsent`). A duplicate key returns the
  existing `messageId`.
- **Claim:** query ready messages with `visibleAt <= now` (ordered index on embedded runtimes), then commit
  `ifVersion` → `leased`, `deliveryCount+1`, `leaseUntil = now + lease`, `leaseOwner`. The loser of a race re-queries.
  An orchestrator message also takes the `wf_run_delivery` record (`requireAbsent`, or `ifVersion` on an expired lease).
- **Renew:** `ifVersion` on the leased record. Any write by a stale owner fails because the version moved.
- **Acknowledge:** delete the message, its key and the run delivery lease, each with `ifVersion`.
- **`{timeoutSeconds}`:** `ifVersion` → ready, `visibleAt = now + n`, same `messageId`. A handoff does not raise the
  counted `deliveryCount`; a separate offset carries it, as Postgres does (`PG/queue.js:1094-1156`).
- **Rejection:** `ifVersion` → ready, `visibleAt = now + backoff`.
- **Expired lease:** claimable again; the next delivery has a higher `deliveryCount`.
- **Wake-ups:** `db.onCommit` where available (Experimental; in-process), plus polling, so correctness never depends on
  a notification.

**Compatibility.**

- Exact for `messageId`, `deliveryCount`, delay, dedupe and per-run serialization.
- Stronger than Postgres on crash recovery: a lease expires after `leaseUntil` (seconds), not 4 hours.
- `retentionSeconds` will be implemented: a message past it is dropped by the maintenance pass and the drop recorded.
- Ordering: delivery is ordered by `visibleAt`, then `messageId`; the contract promises no total order.

**Failure.**

- A crash while leased: redelivered after the lease with `deliveryCount+1`.
- A crash during acknowledgement: either the acknowledgement committed or the message is redelivered (at-least-once;
  the runtime's step deduplication and the event fence make redelivery safe).
- A stale owner's acknowledgement or renewal fails its predicate.

**Verification.**

- Concurrent claimers: each message is leased by exactly one at a time.
- SIGKILL while leased: redelivered once, with a higher count.
- SIGKILL during acknowledgement: no loss.
- Handoff not counted.
- Dedupe window.
- Delayed delivery across a restart.
- `retentionSeconds`.
- Backpressure: a concurrency cap per process.

### 3.5 Streams

**Contract** (`W/interfaces.d.ts:46-99`): `write`, `writeMulti`, `close` (EOF), `get(startIndex)` (a live tail;
negative indexes count from the end), `getChunks` (paged, with a done flag), `getInfo` (tail index, done) and `list(runId)`.

**Postgres.** One row per chunk, `chnk_<per-process ulid>`, with `pg_notify` waking tails. **Chunk order across
processes is not guaranteed**: a late-committing lower id is dropped from a live tail (`PG/streamer.js:170-520`).

**FeltDB.**

- A stream head `wf_streams/<streamId>`, which counts chunks.
- Chunks `wf_chunks/<streamId>.<index>`, written with the head `ifVersion` and the chunk `requireAbsent`, so indexes are
  gap-free and totally ordered across writers.
- Live tails are woken by `onCommit` plus polling.
- Chunk bytes go through the payload boundary (section 6.2); live chunks are batched into one commit per flush, not one per chunk (section 7.2).

**Compatibility: exact**, with a stronger order than Postgres.

**Verification:** concurrent writers give contiguous indexes; a tail started from a negative index; a tail across a
restart; EOF semantics.

### 3.6 Runs, recovery, lifecycle and maintenance

- **`start()`:**
  - Opens FeltDB.
  - Runs `reenqueueActiveRuns` with `queueLost: false`: the queue survives restarts, which is unlike world-local
    (`W/recovery.d.ts`; world-local passes `true`).
  - Starts the poller and a maintenance pass: expired message leases back to ready, `retentionSeconds`,
    hook retention, stale run delivery leases.
- **`close()`:** stops claiming, waits for in-flight handlers within eve's 5 s limit, closes FeltDB (which releases
  the file lock).
- **Cancellation:**
  - `cancelRun` writes `run_cancelled` through `events.create` (`CORE/runtime/runs.js:111-139`).
  - The terminal-run transaction deletes waits and expiring hooks.
  - Queued messages for the run are acknowledged when delivered, because the runtime sees the run is terminal.
- **Timers:** `wait_created`, then a delayed message with a `wait:` idempotency key (`CORE/runtime/spec9/wait-timer.js:62-80`).
  Durable delayed delivery covers it.
- **Deployment id:** synthetic (`dpl_feltdb@<path or url>`), as world-local does.
- **`deploymentAffinity`** is not declared.

**Verification.**

- Restart with pending messages, leased messages and a sleeping run: all resume.
- Cancellation mid-step.
- Two instances on one FeltDB server: only one delivery per run at a time.

### 3.7 `runs.experimentalSetAttributes`, `createRunId`, encryption, snapshots

- **`experimentalSetAttributes`:** head `ifVersion`.
- **`createRunId`:** not implemented; eve has a ULID fallback (`src/internal/workflow/start-claim.ts:14`).
- **`getEncryptionKeyForRun`:** not implemented (Postgres does not implement it either); payloads are stored unencrypted.
- **Snapshots:** not implemented (neither eve nor core reads them).

## 4. Memory (`eve/memory/file` backend)

**Contract** (`src/public/memory/file/backend.ts:30-55`): `read({key}) → {content, version} | null`, and
`write({key, content, expectedVersion: string | null})`.

- `expectedVersion: null` means create-only.
- A stale version throws `MemoryDocumentConflictError`.
- There is **no list, delete, provenance or metadata** in the contract.

The provider above it owns the document format, limits (64 KiB per document, 2 KiB per entry), retries (8) and
scopes (`src/public/memory/file/provider.ts`).

`localFiles` keys files by `sha256(key)` and versions them by `sha256(content)`. Its compare-and-set is serialized
per process only, with one process per directory (`backends/local-files.ts:20-88`).

**FeltDB.** `eve_memory/<sha256(key)>`, holding `{key, content}`; the version is the record's `__version`:

- create: `requireAbsent`;
- update: `ifVersion`;
- `PRECONDITION_FAILED` becomes `MemoryDocumentConflictError`.

**Compatibility: exact, and stronger than `localFiles`.** Compare-and-set holds across processes on a FeltDB server.
Identity and update rules are the provider's, unchanged. There is nothing to merge or deduplicate: the backend stores
the provider's document as is.

**Verification:** the provider's existing backend tests run against the FeltDB backend; conflict across two
processes; a restart.

## 5. Invariants

| #   | Invariant                                                         | Held by                                                                                                                                                                                                       | Proof                                          |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Event positions are never skipped, duplicated or advanced wrongly | head counter + event `requireAbsent` in one commit; head `ifVersion`                                                                                                                                          | concurrent append test; kill mid-append        |
| 2   | Queue messages are not silently lost                              | publish is one durable commit; only acknowledgement or recorded retention deletes; expired leases return to ready                                                                                             | kill while leased and during acknowledgement   |
| 3   | Delivery and acknowledgement survive interruption                 | lease + `deliveryCount` on the record; acknowledgement is a guarded delete                                                                                                                                    | same                                           |
| 4   | Only the current owner commits protected operations               | message lease and run delivery lease are versioned; every owner write is `ifVersion`; run events are fenced by `seqInBand`                                                                                    | stale worker test; fence conformance           |
| 5   | Expired ownership is never taken for current                      | a claim of an expired lease rewrites the record (new version), so the old holder's next write fails. Expiry is decided on the claimant's clock: with several hosts, clock skew must stay well below the lease | lease-expiry test; skew documented             |
| 6   | Concurrent workers cannot create conflicting authoritative state  | every authoritative decision is a predicate on a record keyed by what must be unique; there are no reads inside FeltDB transactions, so nothing relies on them                                                | race tests per uniqueness rule                 |
| 7   | Recovery finds all eligible work                                  | messages are durable records (ready or leased); `reenqueueActiveRuns` from run status; maintenance re-readies expired leases                                                                                  | restart with pending, leased and sleeping work |
| 8   | Memory semantics match eve's                                      | the backend contract is version compare-and-set, kept exactly                                                                                                                                                 | provider tests against the backend             |

**Not claimed:**

- Exactly-once delivery: delivery is at-least-once.
- Exactly-once external side effects: the runtime's step semantics govern them, as on Postgres.

What is exactly-once is each **durable decision**: an event position, a hook claim, a resume, a start admission.

## 6. Design

### 6.1 Contract map summary (final for Phase B)

Sections 3 and 4 are the contract map. Phase A.2 changes it in three places only:

- **Record ids.** FeltDB accepts `[A-Za-z0-9._-]{1,128}`. Composite keys join their parts with `.`; any part that is
  caller-chosen (hook tokens, idempotency keys, memory keys) or could break the pattern or the length is replaced by its
  SHA-256 hex, and the original value is stored in the record.
- **Payloads** (event data, step input and output, hook payloads, stream chunks) cross a payload boundary (6.2)
  instead of always living in the row.
- **Stream chunks** are committed in batches (one commit per flush of `writeMulti` or of a short write window), because
  every commit leaves a transaction id that is never removed (7.2).

Every World operation remains a guarded FeltDB transaction over records keyed by what must be unique; no decision
reads inside a transaction; nothing depends on an Experimental API for correctness (6.4).

### 6.2 Storage architecture and the payload boundary

State falls into three classes, each with one authoritative home:

| Class             | What                                                                                                                                   | Home                                                    | Lifetime                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Operational state | run heads, step/wait/hook views, token claims, resume and admission records, queue messages and leases, stream heads, memory documents | FeltDB records                                          | changes in place; removed only by the state machine (acknowledged message, disposed hook, terminal run) |
| Durable evidence  | the event log: one record per event with type, position, correlation, timestamps, writer, payload reference, payload digest and size   | FeltDB records                                          | kept; never deleted silently (6.3)                                                                      |
| Large payloads    | the bytes of event data, step input/output, hook payloads, stream chunks                                                               | a `PayloadStore` behind the World, addressed by SHA-256 | as long as some record references them                                                                  |

The evidence record carries a `PayloadRef` (`{digest, bytes, store}`), so the log stays interpretable and verifiable
even when the bytes live elsewhere: every read verifies the digest and size and fails closed on a mismatch.

**As built (A.3)** in `packages/eve-world-feltdb/src/payload`: one `PayloadStore` interface (`write`, `read`,
`verify`, `resolve`, `guard`, `usage`, `list`, `export`, `import`, `remove`) and three backends.

- **Every backend indexes each payload with one FeltDB record**, `eve_payloads/<digest>`, committed only after the bytes
  are durable. The record that references a payload commits together with the payload's `guard`, an `ifVersion`
  precondition on that index record. So a committed reference names bytes that were durable when it committed, and a
  payload removed between `write` and the referencing commit makes that commit fail instead of dangle.
- **Removal** deletes the index record first, then the bytes. Writes and removals of one digest are serialized in the
  process (single-process topology, 6.5).
- **Crash windows:** between durable bytes and the index commit, a crash leaves unindexed bytes (the folder backend
  lists them; the content store cannot be listed); between the index commit and the referencing commit, an orphan that
  `findOrphanedPayloads` finds by reference and age. Neither leaves a dangling reference.

| Backend                 | Bytes                                       | Commits per new payload | FeltDB APIs                  | Status                      |
| ----------------------- | ------------------------------------------- | ----------------------- | ---------------------------- | --------------------------- |
| `feltdbRecordPayloads`  | base64 in the index record (in memory)      | 1                       | Stable                       | reference implementation    |
| `feltdbContentPayloads` | FeltDB content store, `<state>/content/`    | 2 (index + ref count)   | content store (Experimental) | candidate, under evaluation |
| `folderPayloads`        | `<root>/<2 hex>/<digest>`, eve-owned folder | 1                       | Stable                       | fallback, recommended now   |

The content store is not made the production option: its durability per write is proven (fsync, rename, directory
fsync), and a copy of the stopped directory restores it (tested), but it has no listing (unindexed bytes after a crash
cannot be found), it costs one more commit per payload for its own reference count, and it is Experimental.

### 6.3 Retention, archival and capacity limits

- **Default: nothing is deleted.** Completed runs, their events and their payloads are kept.
- **Retention is opt-in and explicit:** `retention: { terminalRunsAfter: '30d', archive: sink }`. A run is eligible only
  when it is terminal and older than the window. The maintenance pass exports it (events, views, streams, payloads) to
  the archive sink, verifies the export's digest, and only then deletes its operational records and evidence in guarded
  transactions, leaving a tombstone `wf_archived/<runId>` with `{archivedAt, sink, location, digest, counts}`. A run
  that is not archived is not deleted. Reads of an archived run return a typed `RUN_ARCHIVED` error naming the location.
- **The first sink** writes one JSON Lines file per run to a directory (fsynced). Other sinks implement the same
  interface.
- **Capacity limits are explicit:** `limits: { maxResidentBytes, maxRuns }`. The World tracks its retained bytes (a
  counter record updated in the same transactions). Over the limit, `start` of a new run is refused with a typed
  `CAPACITY_EXCEEDED` (HTTP 507 at eve's session route) that names the limit; running sessions continue. Nothing is
  evicted to make room. `world.status()` reports resident bytes, records, transaction ids, journal size and the last
  compaction, so an operator sees the limit coming.
- **Active sessions are not retainable.** An eve session is one long-lived run (`workflowEntry`, plus a
  `sessionTimeoutWorkflow` run); retention only ever reaches terminal runs. A long active session's growth is bounded
  only by the payload strategy (7.3).

### 6.4 Experimental API dependencies

| API                                                                                                               | Status       | Used for                                                | If absent or removed                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFeltDB`, collections, `db.transaction` with `requireAbsent`/`ifVersion`, bounded `db.query`, `db.snapshot` | Stable       | every correctness decision, reads, backup               | n/a                                                                                                                                           |
| `db.onCommit`                                                                                                     | Experimental | waking queue claimers and stream tails early            | polling (default 250 ms); correctness unchanged                                                                                               |
| `access: 'exclusive'` (file lock)                                                                                 | Experimental | refusing a second process on one directory              | the default behavior of `createFeltDB({ path })`; the World sets nothing                                                                      |
| `db.compact`, `db.journalStatus`                                                                                  | Experimental | status reporting; an explicit compaction in maintenance | not needed for bounds: the file runtime compacts automatically by default (8 MiB journal and the snapshot's size); status reported as unknown |
| `journal.retainOperations`                                                                                        | Experimental | bounding the in-memory operation history                | the history keeps a copy of every value ever written; memory grows with every write                                                           |
| `journal.retainTransactionIdsMs` (FeltDB, unreleased, A.3)                                                        | Experimental | bounding transaction ids (lifetime growth)              | ids grow without bound, ~250 B of heap and ~160 B of snapshot per commit (7.5)                                                                |
| `storeContent` / `acquireContent` / `releaseContent`                                                              | Experimental | `feltdbContent` payload store only                      | `inline` or the World-owned directory                                                                                                         |
| read-basis fences, Durable Work, record expiry, agent state                                                       | Experimental | **not used**                                            | n/a                                                                                                                                           |

Correction to Phase A.2: the file runtime **does** compact on its own by default (a timer after the commit that made it
due); the A.2 benchmark never yielded to the event loop, so its timer never ran. Explicit `db.compact` is therefore not
needed for bounded journals, and the World calls it only behind a capability check, never for correctness. The two
retention options are what an operator needs for a long-lived instance: without them, operation history and transaction
ids grow with every commit (measured, 7.5). Both are Experimental; transaction-id retention is in FeltDB's branch, not
yet released.

### 6.5 Single-process topology and limits

- **The World configures its own FeltDB retention explicitly**, never inheriting a default:
  `journal: { retainOperations, retainTransactionIdsMs }`, with the transaction-id window much longer than the
  longest retry the World makes with one id (proposed: 24 hours of store time). At open, the World refuses a FeltDB
  runtime whose `capabilities().transactionIdRetention` is false, with an error naming the runtime: a move to a FeltDB
  server must not silently bring back unbounded growth.
- **No World correctness depends on transaction-id recognition beyond the window.** Every durable transition carries
  its own precondition (section 3: event slot `requireAbsent`, run head `ifVersion`, token claim `requireAbsent`,
  message lease `ifVersion`, payload guard), so a replay of any World transaction after its id is forgotten fails its
  precondition instead of applying twice. Transaction ids are used only to make a retry of a commit with an unknown
  outcome cheap and exact inside the window.

- One `eve start` process owns one FeltDB directory (`EVE_FELTDB_PATH`), opened with FeltDB's exclusive owner lock. A
  second live process on the same directory is refused with `STATE_LOCKED`, including a paused (`SIGSTOP`) owner.
  FeltDB judges a holder gone only when it is on the same host and its pid no longer exists, so a killed host's
  successor can take over. A killed process can keep its pid for a moment after `SIGKILL` (until it is reaped), so
  `createWorld()` retries `STATE_LOCKED` for up to `EVE_FELTDB_OWNER_WAIT_MS` (default 15 seconds) before failing. A lock
  taken on another host is never judged gone; it needs an operator.
- The queue, its claim loop, leases and the maintenance pass run in that process; eve delivers in-process through
  `registerHandler`. Leases still exist and are still checked: they are what makes a restarted process take over work
  a killed one held.
- **Not supported and not advertised:** several processes on one directory (`access: 'shared'`), several hosts, or a
  FeltDB server in production. The server path (`EVE_FELTDB_URL`) is kept for the correctness matrix only, documented
  as such.
- **Restart** costs the FeltDB reopen time, which grows with retained state (7.2), then `reenqueueActiveRuns`.
- **Backup:** `db.snapshot()` (Stable), or a copy of the directory while stopped. Restore is opening the copy.
- **High availability:** none. A supervisor restarts the process; durable state makes the restart correct, not instant.

### 6.5.1 Recovery after the host dies (verified)

`packages/eve/test/scenarios/feltdb-restart-recovery.scenario.test.ts` builds an agent on this World, runs it with
`eve start`, kills the whole process group with `SIGKILL`, starts a new `eve start` on the same directory, and continues
the same session through the eve channel. Nothing from the first process is reused: no Workflow addresses, no memory.

| Case               | Crash point                                           | After restart                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed effect   | after the tool returned, during the next model call   | the tool's counter stays 1; the model receives the recorded output                                                                                                                          |
| Interrupted effect | while the tool was running, its start still unflushed | not run again; the model is told the call "may or may not have taken effect" (deterministic: Workflow's stream flush window is widened to 1.5 s, so the kill always lands before the flush) |
| Pending approval   | after the step that opened it committed               | the same approval is open; a person without session access can't reach it; a delegate with access is refused as an approver; the requester's approval runs the tool once                    |
| Two sessions       | between turns                                         | each continues with only its own history                                                                                                                                                    |
| Unreadable state   | state written in a newer FeltDB format                | `eve start` fails with `UNSUPPORTED_DURABLE_FORMAT`; the file is untouched; restoring it restores the session                                                                               |
| Two owners         | a second host on a live or paused owner               | refused with `STATE_LOCKED`                                                                                                                                                                 |

How it works is Workflow's own recovery over durable World state, not a new mechanism: the restarted process
re-enqueues active runs, Workflow replays the session program from its event log, and the step that was running
at the crash runs again with `attempt` 2. eve then reads the session lines that step wrote (`readOrphanedLines`),
adopts settled calls, and reports unsettled ones as interrupted (`recoverInterruptedStep`).

**An effect could run twice (fixed in #38).** Between #36 and #38 the interrupted-effect case failed intermittently
(2 of 4 runs on `674046e`): the successor ran the transfer again. #37 attributed this to a stale first read in the
successor. That was wrong. Instrumented runs showed one World instance in the successor, opened after the dead
owner's lock cleared, and both of its reads empty, because the dead owner had never committed the lines; the lines
#37 took for the dead owner's were the successor's own. The successor read the durable state correctly.

The cause is on the write side. Workflow's step writable acknowledges `write()` when a chunk enters its group-commit
buffer, not when the World has committed it; its durability barrier runs only when the step ends
(`@workflow/core` `serialization.js`, "Group-commit buffering"). eve awaited `write()` for `call.started` and then ran
the tool inside the same step, so a host killed in that window lost the record that the call had started. The
retried step then saw no evidence, concluded the call had not run, and ran it.

eve now waits for that barrier after writing a line that starts a call, before the call runs. eve's build exposes
Workflow's own `drainFlushableSnapshot` on the step writable (`scripts/vendor-compiled/@workflow/core.mjs`, which fails
the build if the patched source changes), and the session publisher awaits it after any line carrying `call.started`.
If the barrier fails, publishing fails and the call does not run.

**What a successor can trust:**

- A line a predecessor committed is visible to the successor's first read, and every later read returns the same
  lines (`world.scenario.test.ts`, three kill-and-reopen cycles). FeltDB acknowledges a commit only after its bytes
  are durable, and a successor opens only after the predecessor's lock clears.
- A call that started is recorded durably before it runs. A retried step that finds `call.started` without
  `call.settled` reports the call as interrupted and does not run it.
- A call whose `call.settled` was still buffered at the crash is reported as interrupted, not as completed and not run
  again: an outcome is restored only when its record was committed.
- A gap or a mismatch in the stream fails the step (`readOrphanedLines`: "Cannot reconcile an unreadable or missing
  session line", "Session stream ended before its reported tail"); it is never read as an empty history.

**What remains non-durable or unproven:**

- **An approval opened by a step that had not committed.** The client can see `awaiting-input` before Workflow records
  the step. A crash in that window abandons the approval (`interaction.settled: abandoned, step-interrupted`), and the
  rerun step asks the model again, which may request a new approval. Nothing runs without an answer, but the original
  interaction id is gone.
- **An effect whose outcome was never recorded is reported, not reconciled.** eve cannot tell whether it took effect;
  the model decides, and the application must deduplicate.
- **Single machine.** One process per directory, local files. No shared or multi-host ownership, no fencing token
  across hosts, and a pid reused by an unrelated process keeps the lock until an operator removes it.
- **The queue's orchestrator lease is per process** and is recovered by restart, not by another live process.
- **Not covered by these tests:** subagents and workflow-tool runs in flight at the crash, durable timers set before
  it, and sandbox state.

### 6.6 Package and versioning

- **Package `@appport/eve-world-feltdb` in `packages/eve-world-feltdb`.** The workspace name is the published name: no
  rename at publish time, so installed consumers and the workspace resolve one name. Nothing is published under
  `@eve`, which is upstream's npm scope; this fork publishes under `@appport` (and FeltDB under `@feltdb`). The package
  ships its own NOTICE, naming what it contains, not the repository's.
- **Published name:** the fork publishes only under `@appport` (`scripts/publish-packages.mjs:6` packs `eve` as
  `@appport/eve` through `scripts/pack-scoped-eve.mjs`); `@eve` on npm is upstream's scope. The World is published the
  same gate, as `@appport/eve-world-feltdb` (decided). Built: `scripts/scoped-packages.mjs` lists the publishable
  packages; `pack-scoped-eve.mjs` and `publish-packages.mjs --package <key>` handle both; every publish first passes
  `verify-scoped-package.mjs`: required files present (LICENSE, NOTICE), a clean `npm install` of the tarball in an
  empty project, `gitHead` equal to HEAD, and a smoke round trip. Verified for both packages; nothing was published.
- **Versioned independently** with its own changesets (`@appport/eve-world-feltdb`, allow-listed in
  `assert-changeset-publish-packages.mjs`), starting at 0.1.0 (pre-1.0: the whole public surface is Experimental).
- **Dependencies:** `@workflow/world` as a peer at the major eve pins (which eve's `validate-world.ts` checks), and
  `@feltdb/core` as a peer (`>=0.23.0 <0.25.0` today: the payload stores need 0.23; the World will need the release
  that carries transaction-id retention). No dependency on `eve` or FeltKit; `eve` gains no
  dependency; FeltDB does not know the package exists.
- **Narrow public API:**
  - `createWorld()`: the no-argument factory eve calls, configured from `EVE_FELTDB_PATH` (and `EVE_FELTDB_URL` /
    `EVE_FELTDB_TOKEN` for the correctness matrix);
  - `createFeltDBWorld({ db, payloads?, retention?, limits? })` for a host that owns the database;
  - `feltdbMemory({ db })`, a `MemoryDocumentBackend` for `fileMemory({ backend })`;
  - the `PayloadStore` and archive sink interfaces, and the typed errors.

### 6.7 Upstream adaptation plan

- **Source:** `@workflow/world-local` 5.4.1 (Apache-2.0, `github.com/vercel/workflow`, `packages/world-local`): about
  5.8k lines, of which the event state machine (`storage/events-storage.js`, 1.1k) and the queue (`queue.js`, 1.05k) are
  the parts adapted. World-postgres 5.3.0 is read for its per-event transaction boundaries only.
- **Attribution:** files derived from world-local keep the Apache-2.0 header with upstream's copyright and a
  `Modified by` notice; the package ships upstream's `LICENSE` and a `NOTICE` naming the source version and commit.
  (A license header is one of the comment kinds `AGENTS.md` allows in `packages/`.)
- **Recorded changes,** in `packages/eve-world-feltdb/UPSTREAM.md`: SQLite statements replaced by guarded FeltDB
  transactions; the in-memory queue replaced by the durable record queue (3.4); `queueLost: false` on recovery;
  payload boundary; id encoding; retention and limits.
- **No Postgres assumption carries over:** there is no row lock, no `max(id)+1` retry, no read inside a transaction, no
  `LISTEN/NOTIFY`. Every rule in section 3 is re-derived from predicates, and verified independently (section 9), not
  by matching upstream's output.
- **Tracking upstream:** a Workflow upgrade in eve re-runs the conformance suites against this World in CI; the
  `UPSTREAM.md` diff list is reviewed against the new world-local.

## 7. Capacity and growth model

Everything below is labeled **Measured** (run on the setup stated) or **Estimate** (arithmetic from measured inputs
and stated assumptions). No estimate has been run.

### 7.1 What eve writes per turn (Measured)

Setup: a production build (`eve build`, `eve start`) of a small agent, default World (`@workflow/world-local` 5.4.1,
SQLite), `@workflow/core` 5.6.1, real model `openai/gpt-4.1-mini` through the AI Gateway, one tool call per turn
returning about 1 KB of JSON. Two sessions: one of 10 turns (one turn failed on a gateway 429 rate limit), one of 2.
Bytes are `length()` of the stored columns.

| Per turn (10-turn session)                                             | Count       | Bytes                                                     |
| ---------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| Events (`step_started`, `step_completed`, `attr_set`, `hook_received`) | 7.4         | 13.2 KB (per-turn range 11.5-14.3 KB; first turn 16.3 KB) |
| Step view documents (duplicate the step's input and output)            | 2.1         | 10.3 KB                                                   |
| Stream chunks (the session's output stream)                            | 76          | 16.1 KB (about 210 B each, max 1.7 KB)                    |
| Hook tokens, resumes                                                   | ~1          | ~0.2 KB                                                   |
| **Total written**                                                      | ~87 records | **~40 KB**                                                |

Per session, once: a `workflowEntry` run, a `sessionTimeoutWorkflow` run, 2 hooks, 1 wait: about 9 KB.

**Growth per turn is flat** even though the model's input grew to 13,321 tokens by turn 10: Workflow 5.6 stores
step state as references and deltas against earlier versions in the run's own log (`StateRefV1`,
`CORE/serialization/state-refs.d.ts`), compressed. A session's stored size is linear in its turns, not quadratic.

Two consequences:

- The step view duplicates payload already in `step_completed`. In FeltDB the step record stores a reference to the
  event's payload, not a second copy: about 10 KB per turn less, with the same `steps.get` result.
- Stream chunks are the largest class by count; committed one per chunk they would also be the largest source of
  transaction ids (7.2).

### 7.2 What FeltDB costs (Measured)

Setup: `@feltdb/core` 0.23.0 Node file runtime, Node 26.13.1, 4 vCPU, 16 GB RAM, container local disk. A synthetic
World-shaped load (scratch benchmark, not committed): per turn, one commit of 7 events (1.8 KB) + 1 step (2.5 KB) +
the run head (2 KB), and 8 commits of 10 chunks (210 B): 33.9 KB of payload and 9 commits per turn, close to 7.1's
volume. Heap is `heapUsed` after a forced GC; baseline 11 MB heap, 79 MB RSS.

**Strategy A, every payload in rows:**

| Turns retained | Records | Payload | Journal (uncompacted) | Snapshot (compacted) | Compact | Reopen | Heap after reopen | RSS after reopen |
| -------------- | ------- | ------- | --------------------- | -------------------- | ------- | ------ | ----------------- | ---------------- |
| 200            | 17.8k   | 6.8 MB  | 22.7 MB               | n/a                  | n/a     | 0.12 s | 71 MB             | 234 MB           |
| 2,000          | 178k    | 68 MB   | 228 MB                | 84 MB                | 0.5 s   | 1.27 s | 281 MB            | 516 MB           |
| 6,000          | 534k    | 203 MB  | 686 MB                | 250 MB               | 1.4 s   | 3.72 s | 787 MB            | 1,247 MB         |

- Linear: about **130 KB of heap, 42 KB of snapshot and 114 KB of uncompacted journal per retained turn**, and
  **0.62 ms of reopen per retained turn**. Heap is about 3.8x the raw payload.
- Before compaction the operation history is also in memory: heap was 802 MB at 6,000 turns while writing.
- Commit latency (each one fdatasynced): turn commit p50 1.8-2.0 ms, p95 3.2-3.8 ms, p99 5.7-9 ms; chunk commit p50
  1.2-1.4 ms. It did not degrade with size.

**Strategy B, compact rows, payloads outside** (same shape, row payload scaled to 12%, about 4 KB per turn of
references, digests and small inline values; no chunk rows; 1 commit per turn):

| Turns retained | Records | Snapshot | Reopen | Heap after reopen | Commit p50 / p95 |
| -------------- | ------- | -------- | ------ | ----------------- | ---------------- |
| 2,000          | 18k     | 6.6 MB   | 73 ms  | 39 MB (+28 MB)    | 1.24 / 1.9 ms    |

About **14 KB of heap per retained turn and 0.04 ms of reopen**. The payload store's own cost (files, fsyncs) was not
measured: that is Phase B (section 9).

**Transaction ids are retained forever.** 50,000 commits, each overwriting the same single record, then
`compact({ retainOperations: 100 })`: the snapshot is 7.56 MB (about **150 B per commit**), and heap after reopen grew
by 28 MB (about **560 B per commit**), reopen 44 ms. This matches FeltDB's documentation ("retention never removes
current state, committed transaction ids or their identities", `embedded-state-lifecycle.md:140`). Deleting records
does not reclaim it: every commit a World ever makes stays resident.

Two further observations:

- **The journal is not bounded by default.** With no retention configured, `journalStatus()` reported all 17,800
  operations kept and `retainOperations: null`, and the snapshot was never written (277 bytes) until `compact` ran. The
  public API reference says a never-replicated store keeps its newest 4,096 operations
  (`FDB/docs/reference/public-api.md:217-218`); the measured behavior differs. Reported as a FeltDB documentation or
  behavior defect.
- **Compaction leaves the previous journal on disk** until the next compaction (228 MB beside an 84 MB snapshot at
  2,000 turns). Peak disk is about snapshot + previous journal.

### 7.3 Model (Estimate)

Inputs: 7.1 (eve's write volume), 7.2 (FeltDB's cost per retained turn and per commit). Assumptions, stated because
they move the result: **commits per turn** in the real World are 15-30 with batched chunks (7.4 events, about 2 step
deliveries with publish, claim and acknowledgement each, plus chunk flushes), and **76+ if chunks are committed one by
one**; the resident cost of a commit is 560 B (Measured).

Per turn, resident heap:

| Strategy                                           | Retained-state heap              | Transaction ids (never reclaimed)     | Reopen per retained turn |
| -------------------------------------------------- | -------------------------------- | ------------------------------------- | ------------------------ |
| A. Every payload in rows                           | ~130 KB (Measured shape)         | 8-17 KB (batched), 43+ KB (unbatched) | ~0.62 ms                 |
| B. Compact rows, payloads behind `PayloadStore`    | ~14 KB (Measured shape)          | same                                  | ~0.04 ms + ids           |
| C. B plus archival of terminal runs after a window | ~14 KB x turns inside the window | same, for every turn ever             | window-bounded + ids     |

Per eve deployment (one process), illustrative workloads:

| Workload                              | Turns/day | A: heap/day | B: heap/day (batched ids) | C, 30-day window: steady heap  | Reopen after 30 days (A / B) |
| ------------------------------------- | --------- | ----------- | ------------------------- | ------------------------------ | ---------------------------- |
| Personal agent: 20 sessions x 5 turns | 100       | 13 MB       | 2.2-3.1 MB                | ~42 MB + 0.8-1.7 MB/day of ids | 1.9 s / 0.1 s + ids          |
| Team agent: 200 sessions x 10 turns   | 2,000     | 260 MB      | 45-62 MB                  | ~840 MB + 16-34 MB/day of ids  | 37 s / 2.4 s + ids           |
| Busy agent: 2,000 sessions x 10 turns | 20,000    | 2.6 GB      | 440-620 MB                | 8.4 GB + 160-340 MB/day of ids | not practical / 24 s + ids   |

Long sessions: one 1,000-turn session holds ~130 MB (A) or ~14 MB plus ids (B) for as long as it is active; no
retention applies to it.

**Maximum practical embedded instance (Estimate).** Taking 1 GB of FeltDB heap as the working ceiling for one Node
process (it leaves room for eve, the model SDKs and compaction, which serializes the whole snapshot at once) and a
restart budget of about 10 s:

- A: about **7,500 retained turns** (1 GB) and about 16,000 turns for 10 s of reopen. Days, not months, for a team agent.
- B: about **32,000-45,000 retained turns** with batched ids, limited by heap before reopen time.
- C: the window is bounded, but transaction ids are not: with batching, 1 GB of ids is reached after roughly 60,000-120,000
  turns in the instance's lifetime, whatever is archived. **No strategy is steady-state on FeltDB 0.23** without a
  FeltDB change (transaction-identity retention) or a periodic rotation of the store, which would itself be an
  archival operation.

Disk is not the limit in any case: under 1 GB for the in-memory ceilings above, plus the payload store (about 30 KB per
turn in B, Estimate).

### 7.4 Stable and Experimental, per strategy

| Strategy | Correctness depends on                         | Operations want (Experimental)                                                                                     |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A        | Stable only                                    | `db.compact` (journal and reopen time)                                                                             |
| B        | Stable, plus the chosen payload store          | `db.compact`; the content store if `feltdbContent` is chosen                                                       |
| C        | Stable, the payload store and the archive sink | `db.compact`; the content store if chosen. Without transaction-identity retention in FeltDB, C is not steady-state |

**Recommendation:** build A and B behind the `PayloadStore` interface in Phase B (A is `inline`, which costs nothing
extra), make B the documented production configuration once measured, and add C's archival when a FeltDB
transaction-identity retention policy exists or when an operator needs it, whichever comes first. Disk-resident FeltDB
rows remain the long-term platform requirement, as decided; they are not a prerequisite.

## 8. FeltDB gaps found

- **Rows are memory-resident** in every runtime (decided: longer-term platform requirement).
- **Committed transaction ids are never removed** and cost about 560 B of heap each (Measured). For a long-lived
  embedded store this is unbounded growth independent of retention. Proposed FeltDB change: a retention window for
  transaction identities (for example, ids older than N days or beyond the newest N), with idempotent retry guaranteed
  only within it.
- **The journal is unbounded by default** on the file runtime, contrary to the documented 4,096-operation default
  (Measured).
- **`db.compact` is Experimental** yet is the only way to bound journal size and reopen time.
- **Compaction keeps the previous journal** until the next compaction (Measured; may be intentional, undocumented).
- **The server has no ordered or range indexes.**
- **Durable Work** has no claim-next and is server-only.
- **`onCommit`** has no durable cursor and is in-process only on embedded runtimes.
- **The shared file lock times out with an untyped `Error`.**
- **Lease expiry** is checked with `Date.now()` while record expiry uses the injectable clock
  (`FDB/packages/core/src/embedded-transaction.ts:442`).
- **Documentation conflict:** agent state's runtime validation differs between `agent-state.md` and `guarantees.md`.

## 9. Test and benchmark plan (Phases B-C)

**Correctness.**

- Workflow's `inBandFenceConformance` and `atomicStartHookConformance` against the FeltDB World, and against Postgres
  where a database is available. They are partial suites and are reported as partial.
- One behavioral suite run against both Worlds for every row of section 3: concurrent appends (positions 1..N, no
  gaps), stale `expectedSeqInBand`, token races, resume dedupe, force claim racing a resume, queue lease and
  redelivery, handoff, dedupe window, delayed delivery across restart, `retentionSeconds`, stream ordering and tails.
- Crash tests with a real `SIGKILL` of a child process and a fresh process on the same directory: mid-append, while a
  message is leased, during acknowledgement, between `PayloadStore.put` and the commit (orphan, no dangling reference),
  during archival (the run is either fully present or archived with a verified export), during compaction.
- Payload integrity: a corrupted payload file is refused on read, never returned.
- Capacity limits: `CAPACITY_EXCEEDED` on new runs at the limit; running sessions unaffected; nothing evicted.
- `feltdbMemory` against the memory provider's existing backend tests.
- eve's e2e matrix: `{ "name": "feltdb", "package": "@appport/eve-world-feltdb" }` next to `postgres` in
  `e2e/matrix.json`, so the mock-model eval suite runs on both.
- Standalone example `examples/feltdb-world`: an agent on `EVE_FELTDB_PATH`, work submitted, memory saved, process
  killed, restarted, work finished. No FeltKit.

**Benchmarks** (committed, reproducible, run on Node 26, numbers stated with their setup):

- Per turn: records, bytes and commits written by the real World under the 7.1 workload (replacing 7.3's commit
  assumption with a measurement).
- Heap, RSS, disk, reopen and compaction time against retained turns, for `inline`, `feltdbContent` and (if built) the
  directory store, to 10,000 turns.
- Cold replay of a long session (restart, then the next turn): eve reads the whole run log on a cold delivery and only
  the tail when warm (`CORE/runtime/spec9/delivery.js:902-925`); with payloads outside, a cold replay reads every
  payload of the session.
- Queue throughput and latency per process (claim, acknowledgement) with fdatasync per commit, against world-local and
  Postgres on the same machine.
- Restart-to-first-delivery time against retained size.

## 10. Remaining architectural risks

1. **Unbounded transaction-id residency** (8). Without a FeltDB change, every embedded instance eventually needs a
   restart into a fresh store. This is the risk that most limits a long-lived single-process deployment.
2. **Memory residency** of rows: bounded by the payload strategy, not removed. Documented ceilings, not hidden.
3. **`db.compact` is Experimental** but operationally necessary; if it changes shape, the maintenance pass changes with
   it.
4. **Cold replay cost** of long sessions under strategy B is unmeasured; it could make restarts of long sessions slow
   even when reopen is fast.
5. **Commit rate.** Each commit is one fdatasync (about 1-4 ms here; disk-dependent). A busy agent's queue and stream
   traffic is serialized through one process; the benchmark will show the ceiling.
6. **Spec churn:** the World tracks every Workflow upgrade eve takes; the conformance suites in CI are the guard.
7. **The Postgres reference has its own crash gaps** (4-hour stale locks, no `retentionSeconds`, cross-process stream
   order); the matrix will report them as Postgres limits, not loosen either World.
8. **Payload store as a second store:** if the content store is not accepted, the World owns a directory's
   consistency. The write order (put, then reference) and the orphan sweep are the whole design; they get crash tests.

## 11. Decisions taken (Phase A.2 review) and what remains open

1. **Payload store:** one abstraction, three backends; the FeltDB record backend is the correctness reference, the
   folder backend the likely production candidate, the content store out of the production path until its backup,
   restore and durability are proven. Built (6.2).
2. **Compaction:** allowed behind a capability check, never for correctness. Moot for bounds: the file runtime
   compacts automatically (6.4).
3. **Transaction-id retention:** a FeltDB change, not store rotation. Built in FeltDB (rkendel1/flow_db#478, store
   time, Experimental, unreleased); conditionally accepted pending the contract edge cases (now tested there) and this
   report's provenance-checked capacity evidence.
4. **Published name:** `@appport/eve-world-feltdb`, the same name in the workspace.
5. **Open:** the World implementation (queue, sessions, events, fences, memory) stays on hold until the live and
   lifetime capacity results in section 7 are accepted.

## 12. Corrections to `feltkit/docs/EVE-COMPOSITION.md`

- **The commit listener** is Experimental and in-process only on embedded runtimes (at-most-once on a server), not a
  general wake-up mechanism. The queue polls, and uses the listener only to wake early.
- **eve also hard-requires `atomicStartHook`,** not only `inBandFence`.
- **Missing findings:** memory residency, transaction-id residency and the capacity ceilings of section 7.

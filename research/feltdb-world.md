---
issue: "none: EVE on FeltDB milestone, Phase A (no tracking issue yet)"
status: proposed
last_updated: "2026-11-24"
---

# A FeltDB Workflow World for eve (Phase A: contract and design review)

Goal: eve runs its complete lifecycle on FeltDB, with no FeltKit, through a Workflow **World** implemented over
FeltDB's supported public API, beside the existing Postgres World (which stays the reference). This document maps
every World operation eve uses to the Postgres implementation and to a FeltDB primitive, states the invariants
and how each is held, and lists the decisions needed before implementation.

Sources (checked at the commits below; `W` = `@workflow/world@5.2.2/dist`, `PG` = `@workflow/world-postgres@5.3.0/dist`,
`CORE` = `@workflow/core@5.6.1/dist` (the version eve pins, `packages/eve/package.json:698`), `FDB` = `flow_db`
repository, eve paths relative to `packages/eve`):

| Repository       | Commit                               | Note                                                                         |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| eve2             | `ab46131` (main; contains `a88c765`) | `eve` 1.1.0 = published `@appport/eve` 1.1.0, plus an unreleased license fix |
| flow_db (FeltDB) | `bc6343a3` (main)                    | `@feltdb/core` 0.23.0 = published                                            |

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

| Property                                          | FeltDB 0.23                                                                                                                                                                                      | Source                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Atomic multi-record, multi-collection transaction | yes, one journal record                                                                                                                                                                          | `FDB/packages/core/src/file-db.ts:1277-1353`                                   |
| Reads inside a transaction                        | **none**: the callback only stages writes; no snapshot isolation, no read tracking                                                                                                               | `FDB/public-docs/guarantees.md:104-115`                                        |
| Commit-time validation                            | only explicit predicates: `requireAbsent`, `ifVersion`, `expectedEpoch`, `expectedLeaseId`, experimental read-basis fences                                                                       | `FDB/packages/core/src/embedded-transaction.ts:421-497`                        |
| Versioning                                        | a guarded write stores N+1; **an unguarded write stores `__version` verbatim** and delete+recreate restarts at 1 (ABA)                                                                           | `FDB/docs/architecture/transaction-version-contract.md:66-73,188-192`          |
| Conflict                                          | `ConditionalConflictError`, `PRECONDITION_FAILED`, with the failed predicate                                                                                                                     | `FDB/docs/reference/public-api.md:251-267`                                     |
| Idempotent transaction ids                        | same id and payload returns the original result; a different payload is `IDEMPOTENCY_CONFLICT`; embedded runtimes do not keep ids without bound                                                  | `FDB/public-docs/guarantees.md:118-155`; `public-api.md:157-160`               |
| Durability (file runtime)                         | each commit fdatasynced before acknowledgement (no group commit); SIGKILL tested; power loss **unproven**                                                                                        | `FDB/docs/reference/durability.md:48-49,198-206`                               |
| Multiple processes                                | file runtime is exclusive by default (`STATE_LOCKED`); `access:'shared'` is Experimental, polls a lock for up to about 5 s and then throws an untyped `Error`; multi-host needs the server       | `FDB/packages/core/src/file-db.ts:1186-1271`                                   |
| Queries                                           | bounded `db.query` (where, orderBy, limit 1-1000, keyset cursor); ordered compound indexes on embedded runtimes; **the server has equality indexes only**                                        | `FDB/docs/reference/bounded-authority-query.md:56-64,155-158`                  |
| Change notification                               | `db.onCommit` (Experimental): in-process only on embedded runtimes; at-most-once over SSE on the server; no durable cursor                                                                       | `FDB/packages/core/src/embedded-features.ts:258-316`; `http-db.ts:1324-1415`   |
| Queue or work primitive                           | `db.workloads` (Durable Work): Experimental, **server only**, no claim-next                                                                                                                      | `FDB/packages/core/src/workload.ts:51-63`                                      |
| **Residency**                                     | **every runtime holds all rows in process memory** (file runtime `this.state.rows`; Rust authority `rows: HashMap`) plus a journal and checkpoints                                               | `FDB/packages/core/src/file-db.ts:603-632`; `FDB/crates/feltdb/src/lib.rs:698` |
| API status                                        | Stable: `createFeltDB`, collections, transactions, CAS, bounded `db.query`, `db.snapshot`. Experimental: `onCommit`, expiry, file ownership (`access`), Durable Work, content store, agent state | `FDB/docs/reference/public-api.md:486-519`                                     |

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
   - the event `wf_events/<runId>:<slot>` with `requireAbsent`;
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
| `step_*`            | `wf_steps/<runId>:<stepId>` (`requireAbsent` on create; `ifVersion` on transitions)                                                                            |
| `wait_*`            | `wf_waits/<runId>:<correlationId>`                                                                                                                             |
| `hook_created`      | `wf_hooks/<hookId>` plus token claim `wf_hook_tokens/<token>` (`requireAbsent`: global token uniqueness)                                                       |
| `hook_received`     | resume record `wf_hook_resumes/<runId>:<resumeId>` (`requireAbsent`: dedupe), under the run head                                                               |
| `hook_disposed`     | delete hook and token claim (`ifVersion`)                                                                                                                      |
| force claim         | victim's `hook_disposed`, delete victim hook, move the token claim (`ifVersion`), claimer's hook: one transaction over two run heads                           |

Entity uniqueness, which Postgres enforces with a partial unique index (`PG/schema.js:146,156`), becomes
`wf_entities/<runId>:<correlationId>:<type>` with `requireAbsent`.

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
- `wf_message_keys/<queue>:<idempotencyKey>`: `requireAbsent` gives the dedupe; the record is deleted when its message is acknowledged
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
- Chunks `wf_chunks/<streamId>:<index>`, written with the head `ifVersion` and the chunk `requireAbsent`, so indexes are
  gap-free and totally ordered across writers.
- Live tails are woken by `onCommit` plus polling.
- Bytes are base64 in the record, or in FeltDB's content store (see section 7).

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

**Package.** `@appport/eve-world-feltdb` in the eve2 monorepo (`packages/eve-world-feltdb`).

- Dependencies: `@feltdb/core` (public API), and `@workflow/world` as a peer at eve's pinned major, which also passes
  eve's compatibility check.
- It does not depend on `eve` or FeltKit. eve itself gains no runtime dependency.
- Entry points:
  - `createWorld()` (env: `FELTDB_PATH` for the embedded file runtime, or `FELTDB_URL` + `FELTDB_TOKEN` for a server)
  - `createFeltDBWorld({ db })` for a caller that owns the database
  - `feltdbMemory({ db })` for `fileMemory({ backend })`

**Collections.**

- Runs: `wf_runs`, `wf_events`, `wf_steps`, `wf_waits`, `wf_admissions`
- Hooks: `wf_hooks`, `wf_hook_tokens`, `wf_hook_resumes`
- Uniqueness: `wf_entities`
- Streams: `wf_streams`, `wf_chunks`
- Queue: `wf_messages`, `wf_message_keys`, `wf_run_delivery`
- Memory: `eve_memory`

Every write is guarded. **Supported surface only:** Stable APIs (`createFeltDB`, collections, `db.transaction` with
predicates, `db.query`). Three Experimental APIs are used with a fallback and named in the docs:

- `db.onCommit`: wake-ups, with polling;
- `access:'exclusive'`: the default anyway;
- possibly the content store (section 7).

**Starting point.** The event state machine follows world-local's (`@workflow/world-local`, about 5.8k lines,
Apache-2.0) and world-postgres's per-event transactions, adapted to predicates. The source is credited, not
re-invented. Estimated size: storage and events 2-3k lines, queue 1-1.5k, streams 0.3k, memory 0.1k, plus tests.

## 7. Design review: findings that need a decision before implementation

1. **FeltDB holds the whole dataset in memory, in every runtime.** This is the largest risk.
   - The file runtime keeps every row in process memory (`FDB/packages/core/src/file-db.ts:603-632`), and so does the
     Rust server (`FDB/crates/feltdb/src/lib.rs:698`).
   - A World is append-only: every event, step, hook and **every streamed chunk of model output** stays a row until
     deleted. Postgres keeps them on disk.
   - On FeltDB the working set is everything retained, and a long-lived eve session is one run whose log grows with
     every turn.
   - Mitigations, which need decisions:
     - (a) Retention: delete terminal runs' events, steps and streams after a configurable window.
     - (b) Put chunk and payload bytes in FeltDB's content store, which is file-backed, keeping only references in rows.
       It is Experimental and file/server only.
     - (c) Fix it in FeltDB with disk-resident rows, the right long-term answer and a FeltDB project.
     - Without (b) or (c), FeltDB World capacity is bounded by RAM, and that must be documented as a hard limit.
2. **Multi-process and multi-host.**
   - The embedded file runtime is single-process; `shared` access is Experimental.
   - Several eve processes need a FeltDB server, where **queries have equality indexes only**: the queue's
     `visibleAt <= now` claim and ordered lists scan.
   - Proposal: the milestone targets the embedded file runtime (one `eve start` process, like world-local but with a
     durable queue), with the server supported for correctness and documented capacity. Ordered server indexes are a
     FeltDB gap.
3. **No group commit.** Every queue claim, acknowledgement and event is its own fdatasync. Postgres batches. Expect
   lower throughput per process; the benchmark will measure it rather than guess.
4. **Package home.** A World depends on Workflow, not on eve. It could live in eve2 (proposed: eve pins and tests
   Worlds) or in flow_db as `@feltdb/workflow-world`. That must not make FeltDB depend on eve, and it doesn't.
5. **Durable Work is unusable as the queue** (server-only, no claim-next, Experimental). The World therefore carries
   its own queue, about 1k lines. Generalizing it into FeltDB later would mean adding claim-next to Durable Work and
   embedded support. This is recorded as a FeltDB gap, not built now.
6. **Spec churn.** eve pins Workflow versions (`validate-world.ts:27-51`); the World must move with every Workflow
   upgrade. The fence and start-hook conformance suites run in CI to catch it.
7. **The Postgres reference is not flawless.** Its 4-hour stale locks, missing `retentionSeconds`, and cross-process
   stream order mean "the same behavioral tests against both" will show Postgres failing some of the crash scenarios
   (for example a SIGKILL during a step delivery recovers only after `jobLockStaleSeconds`). Those results will be
   reported as Postgres limits, not loosened for either World.

## 8. FeltDB gaps found

- **Rows are memory-resident** in every runtime.
- **The server has no ordered or range indexes.**
- **Durable Work** has no claim-next and is server-only.
- **`onCommit`** has no durable cursor and is in-process only on embedded runtimes.
- **The shared file lock times out with an untyped `Error`.**
- **Lease expiry** is checked with `Date.now()` while record expiry uses the injectable clock
  (`FDB/packages/core/src/embedded-transaction.ts:442`).
- **Documentation conflict:** agent state's runtime validation differs between `agent-state.md` and `guarantees.md`.

## 9. Verification plan (Phases B-C)

- **Conformance:** Workflow's `inBandFenceConformance` and `atomicStartHookConformance` against the FeltDB World. Run
  against Postgres too where a database is available; they are partial suites and are reported as partial.
- **Behavioral matrix:** one suite, run against both Worlds, for every row of section 3 and every scenario in the
  milestone brief. Real SIGKILL of a child process and a fresh process on the same storage. Postgres runs in a local
  `postgres:18` container, as eve's CI job does (`.github/workflows/e2e-postgres.yml:75-147`).
- **eve e2e matrix:** add `{ "name": "feltdb", "package": "@appport/eve-world-feltdb" }` to `e2e/matrix.json`, next
  to `postgres`. The mock-model eval suite then runs on both.
- **Standalone example:** `examples/feltdb-world`. An eve agent on `FELTDB_PATH`, `eve start`, work submitted, memory
  saved, process killed, restarted, work finished. It uses no FeltKit.

## 10. Corrections to `feltkit/docs/EVE-COMPOSITION.md`

- **The commit listener** is Experimental and in-process only on embedded runtimes (at-most-once on a server), not a
  general wake-up mechanism. The queue polls, and uses the listener only to wake early.
- **eve also hard-requires `atomicStartHook`,** not only `inBandFence`.
- **Missing finding:** the memory residency above.

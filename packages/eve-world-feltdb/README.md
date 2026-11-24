# @appport/eve-world-feltdb

FeltDB storage for eve's Workflow World. **Status: payload storage only.** The World itself (queue, sessions, events,
fences, memory) is not implemented yet; see [`research/feltdb-world.md`](../../research/feltdb-world.md).

Published as `@appport/eve-world-feltdb`, the same name it has in this workspace, and versioned independently of
`eve`. Nothing is published under `@eve`, which is upstream's npm scope.

## Compatibility

| Requires       | Range              |
| -------------- | ------------------ |
| Node.js        | 26 or later        |
| `@feltdb/core` | `>=0.25.0 <0.26.0` |
| `eve`          | not a dependency   |

It does not depend on `eve` or FeltKit, and FeltDB does not depend on it.

## Memory

An agent on this World keeps its `fileMemory` documents in FeltDB too:

```ts
import { feltdbWorldMemory } from "@appport/eve-world-feltdb";
import { fileMemory } from "eve/memory/file";

const provider = fileMemory({ backend: feltdbWorldMemory() });
```

`feltdbWorldMemory()` opens `<EVE_FELTDB_PATH>/memory` once per process, with the World's transaction-id retention. A
write is conditional on the version it read (`MemoryDocumentConflictError` otherwise), as eve's memory contract requires.

## Payload storage

Large values (event data, step input and output, stream chunks) live behind a `PayloadStore`. An authoritative record
stores a `PayloadRef` (`{ digest, bytes, store }`, the digest a SHA-256 of the bytes) instead of the bytes.

```ts
import { createFeltDB } from "@feltdb/core";
import { folderPayloads } from "@appport/eve-world-feltdb";

const db = createFeltDB({ path: ".eve/feltdb" });
const payloads = folderPayloads({ db, root: ".eve/payloads" });

const ref = await payloads.write(bytes);
const guard = await payloads.guard(ref);
await db.transaction((tx) => {
  tx.require(guard);
  tx.collection("events").set(eventId, { ref }, { requireAbsent: true });
});
```

Three backends implement it:

| Backend                 | Bytes live in                               | FeltDB APIs used             | Status                                    |
| ----------------------- | ------------------------------------------- | ---------------------------- | ----------------------------------------- |
| `feltdbRecordPayloads`  | the FeltDB index record (base64), in memory | Stable only                  | reference implementation                  |
| `feltdbContentPayloads` | FeltDB's content store (Node file runtime)  | content store (Experimental) | candidate, under evaluation               |
| `folderPayloads`        | files in a directory eve owns               | Stable only                  | fallback independent of Experimental APIs |

### Guarantees

- **A committed reference never names bytes that were not durable.** Bytes are made durable first (content store:
  fsynced before `storeContent` returns; folder: temporary file fsynced, renamed, directory fsynced), then the payload's
  FeltDB index record (`eve_payloads/<digest>`) is committed. A record that references the payload commits together
  with the payload's `guard`, a version precondition on that index record, so it fails instead of committing if the
  payload was removed in between.
- **Every read is verified** against the digest and size. A mismatch is `PayloadIntegrityError` and the bytes are
  never returned; a missing index record or missing bytes is `PayloadMissingError`. `verify` reports `ok`, `missing` or
  `corrupt` without throwing.
- **Repeated payloads are stored once**: writing bytes already indexed returns the existing reference.
- **Removal** deletes the index record first, then the bytes. `findOrphanedPayloads` lists indexed payloads no record
  references and older than a grace period; nothing is removed unless the caller removes it.
- **Crash leftovers:** a crash between durable bytes and their index commit leaves unindexed bytes, never a dangling
  reference. The folder backend lists them (`unindexed()`); the content-store backend cannot (FeltDB offers no content
  listing). A crash after the index commit and before the referencing commit leaves an orphan that
  `findOrphanedPayloads` finds.
- **Export and restore:** `export()` yields every payload with verified bytes; `import()` verifies each against its
  digest and writes it. A copy of the stopped FeltDB and payload directories restores both.
- One store instance per process and database: writes and removals of a digest are serialized in-process. Several
  processes on one store are not supported.

## Capacity benchmark

`bench/capacity.mjs` measures the storage cost of a simulated World turn shaped like what eve 1.1 writes per turn
(7 events of about 1.9 KB, 2 step deliveries through a record queue, 76 stream chunks flushed in 8 batches; random,
incompressible payloads; 10 turns per session; the store's clock advances 2 s per turn):

```sh
pnpm --filter @appport/eve-world-feltdb build
node --expose-gc packages/eve-world-feltdb/bench/capacity.mjs --backend folder --turns 5000 [--archive] [--retain-ids-forever]
```

`--backend` is `feltdb-record`, `feltdb-content` or `folder`. `--archive` deletes each session's records and payloads 20
sessions after it ends, so what remains is lifetime growth. Transaction ids are retained for 10 minutes of store time
(`--retain-ids-ms`) unless `--retain-ids-forever`.

The benchmark first prints its provenance: the FeltDB build (package version, git commit, whether its `src` is dirty,
a SHA-256 of its `dist`, and whether it has transaction-id retention) and this package's commit. It refuses a FeltDB
build without retention, and uncommitted source on either side unless `--allow-dirty`. `FELTDB_CORE` names that
build's `dist/index.js`; by default the installed `@feltdb/core` is measured, and its provenance is read from its
`dist/build-identity.json` (source commit, clean flag) and the lockfile (integrity).

The workload runs in a child process that is killed with `SIGKILL` once it has written everything; the parent then
measures crash recovery (opening the killed store), a clean reopen, a backup (a copy of the stopped directories) and a
restore that verifies every referenced payload in both copies.

# @appport/eve-world-feltdb

## 0.1.2

### Patch Changes

- `feltdbWorldMemory()` stores an agent's `fileMemory` documents in FeltDB beside the FeltDB World.

  Use `fileMemory({ backend: feltdbWorldMemory() })` in an agent that runs on `@appport/eve-world-feltdb`: it opens `<EVE_FELTDB_PATH>/memory` once per process with the World's transaction-id retention, so memory no longer needs local files.

## 0.1.1

### Patch Changes

- `feltdbWorldMemory()` stores an agent's `fileMemory` documents in FeltDB beside the FeltDB World.

  Use `fileMemory({ backend: feltdbWorldMemory() })` in an agent that runs on `@appport/eve-world-feltdb`: it opens `<EVE_FELTDB_PATH>/memory` once per process with the World's transaction-id retention, so memory no longer needs local files.

## 0.1.0

### Minor Changes

- 4a66499: New package `@appport/eve-world-feltdb` adds durable, verified payload storage for eve's FeltDB World.

  It has three backends: FeltDB records, FeltDB's content store, and a folder eve owns. The World itself is not included yet.

# eve + AppPort: minimal agent foundation

Branch `claude/dreamy-galileo-4z03p5`.

| Item  | Location                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent | `examples/appport-agent/` (commit `fcb552a`)                                                                                                  |
| eve   | 1.0.2 from this fork, including the self-hosting work in `audits/vercel-decoupling`, `audits/self-hosted-parity`, and `audits/vercel-removal` |
| Node  | 26.13.1 (CI)                                                                                                                                  |

Repositories inspected:

| Repository                  | Commit    |
| --------------------------- | --------- |
| `rkendel1/appport`          | `a6c2c61` |
| `rkendel1/flow_db` (FeltDB) | `0f5049e` |
| `rkendel1/secret-agent`     | `20a451b` |
| `rkendel1/stack-agent`      | `c066006` |
| `rkendel1/chip-rs`          | `c14522a` |
| `rkendel1/3fx`              | `2d5151e` |
| `rkendel1/personalOS`       | `c684688` |

## Architecture

```
caller --JWT--> eve channel (jwtHmac) --> agent turn (Workflow world, SQLite)
                                             |
                       appport_* tools (agent/lib/appport.ts)
                                             |  @appport/client + transport-http
                                             |  Bearer: caller assertion (sub = eve principal, act = agent)
                                             v
                       AppPort host: authenticate hook -> permissionAuthorizer -> capability
                                             |
                                       TelemetrySink -> provenance JSONL
```

| Responsibility                                             | Owner                                                             | Notes                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Harness, turns, durable sessions, route auth               | eve (unchanged)                                                   | No parallel orchestration, tool registry, or memory              |
| Capability discovery, contracts, authorization, invocation | AppPort (existing HTTP binding, manifest, `permissionAuthorizer`) | No new AppPort abstraction                                       |
| Caller identity into AppPort                               | Host `authenticate` hook (AppPort's own design)                   | Interim HS256 assertion; AuthBoundry recommended next (see gaps) |
| Execution provenance                                       | AppPort `TelemetrySink` → JSONL; eve's session history            | Not yet in FeltDB                                                |
| Durable work state                                         | eve Workflow world                                                | FeltDB not wired; see gaps                                       |

Model exposure: three tools. Invocation is limited to operator-allowlisted capabilities with an explicit `effect: "observation"`. There are no raw privileged operations.

## Evidence

**Implemented and verified by execution**, all automated in `examples/appport-agent/test/acceptance.test.mjs` and run in CI.

| Claim                                               | How proven                                                                                                 | Inference          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| The agent can discover the capability               | `listCapabilities` against real AppPort                                                                    | none               |
| The agent can understand its contract               | `readContract`: `inputSchema.required = ["sku"]`                                                           | none               |
| An authorized invocation succeeds                   | Output equals `catalog.json`'s entry, read independently                                                   | none               |
| An unauthorized invocation is rejected              | Bob → `FORBIDDEN`; forged assertion → `UNAUTHORIZED`                                                       | none               |
| Invalid input is rejected by the contract           | `{}` and `{sku: 5}` → `INVALID_INPUT`                                                                      | none               |
| Privileged or unlisted capabilities are not exposed | `NOT_EXPOSED`; no AppPort request sent                                                                     | none               |
| Provenance is retained                              | JSONL record per `requestId` with principal, session, outcome                                              | none               |
| End to end through the agent                        | Built `eve start` agent: Alice's answer `42` comes through AppPort; Bob's attempt is rejected and recorded | **real Anthropic** |
| Works after restart                                 | `SIGKILL` + `eve start`; the same session answers `7`                                                      | **real Anthropic** |
| Unauthenticated access rejected                     | `POST /eve/v1/session` → 401                                                                               | none               |
| Existing eve behavior intact                        | eve unit 9,352 / integration 2,675 / scenario 372 pass (known pre-existing pnpm failure only)              | n/a                |

Result: 10/10 with the key; 7/7 plus the e2e suite skipped without it. The key never appeared in logs.

**Simulated:** the AppPort application is a test host (`appport-host/`) with a JSON file as its data source. Identity uses a shared-secret assertion rather than an identity provider.

**Unverified assumptions:**

- the same `authenticate` contract in a production AppPort deployment;
- behavior with the Postgres world.

## Findings from real execution

1. **The published client drops `authorizationDecision`.** `@appport/client@1.1.8` / `@appport/protocol@1.5.0` lack it, although the AppPort server sends it (verified on the raw HTTP response) and the repository source at the same version numbers handles it. The decision id therefore doesn't reach the agent. AppPort's provenance records still identify every call.
2. **The AppPort HTTP transport's `url` is the endpoint** (`…/appport`), not the origin.
3. **eve's `jwtHmac` principal ids are issuer-namespaced** (`issuer:sub`). The AppPort host must key permissions by that id.
4. **AppPort telemetry records `principal` as an id string.** The acting agent is visible only through the host-assigned `sessionId` (`agent_<jti>`).

## Capability disposition (Phase 4: nothing ported)

| Project | Status                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------- |
| chip-rs | Superseded by stack-agent; nothing unique except an abandoned (NO-GO) session-memory experiment |
| 3fx     | A copy of fx (Zig); not integrable code                                                         |

| Capability                                                                                     | Source                                                                            | Tests                                        | Demonstrated                                               | Limits                       | eve has it?            | Integrate?                                                 | Smallest integration                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ---------------------------- | ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Deterministic stuck/loop guard                                                                 | `stack-agent/crates/chip-core/src/stuck.rs`                                       | `chip-core/tests/stuck_guard.rs` (offline)   | Exact thresholds, bounded window, restore-stable           | Rust                         | No                     | **Yes, when a loop is observed**                           | Port the ~170-line rule as an eve hook on tool calls                       |
| Credential-file deny-list for file tools                                                       | `stack-agent/crates/chip-project/src/policy.rs`                                   | `chip-project/tests/path_policy.rs`          | `.env`/keys never readable or listable                     | Rust                         | No                     | Only when file tools are enabled (they're off here)        | A sandbox `prepare` and read-file guard with the same fixture              |
| Verification-gated completion                                                                  | `stack-agent` `software_work.rs` + `chip-core`                                    | `tests/completion_evidence.rs`               | "Done" requires a passing test after the last write        | Needs PAX; coding-only       | No                     | No (not a coding agent)                                    | —                                                                          |
| Intent/outcome reconciliation, keyed idempotent effects                                        | `chip-agent-state/src/reconcile.rs`, `chip-project/src/journal.rs`                | `reconciliation`, `idempotency` tests        | Uncertain outcomes never re-executed                       | FeltDB 0.2                   | Partial                | **Yes, before the first consequential AppPort capability** | AppPort `idempotencyKey` plus a FeltDB-backed intent record per invocation |
| Durable work state                                                                             | `chip-agent-state`                                                                | 132 tests                                    | Fencing, leases                                            | FeltDB                       | Yes (Workflow world)   | No                                                         | —                                                                          |
| Confirmed/inferred memory with sources                                                         | `personalOS/feltkit/memory.ts`, `_ops.ts`                                         | `assistant.test.ts`                          | Hedged recall, approval to forget                          | FeltKit                      | Partial (`fileMemory`) | Later                                                      | A custom eve memory provider with status and source fields                 |
| Research pipeline with verified quotes and a safe page reader                                  | `personalOS/feltkit/_research*.ts`, `_pages.ts`                                   | `research*.test.ts`, `pages.test.ts`         | Quotes verified verbatim; robots.txt and private-IP blocks | Org-search focus             | Partial                | When research is a use case                                | Port the pure modules as eve tools                                         |
| Shared content treated as data, not instructions                                               | `personalOS/feltkit/_invocation.ts`                                               | `invocations.test.ts`                        | Instruction-bearing shares not acted on                    | —                            | No                     | When a share channel is added                              | An eve channel route wrapping content as non-instruction context           |
| Cross-surface identity links and per-user delegation                                           | `personalOS` `links.ts`, `_resolver.ts`, `_authority.ts` (AuthBoundry + Resolver) | `interactions.test.ts`, `*-authboundry-real` | Forged identity refused, revocation honored                | Needs Resolver + AuthBoundry | No                     | **Yes: the identity step below**                           | `@authboundry/local` delegation checks in the AppPort host's authorizer    |
| AppPort contract knowledge (validate, graph, replacement boundary)                             | `secret-agent/crates/agent-core/src/appport/knowledge`, `3fx/src/core/appport`    | Offline snapshot tests                       | Matches the `@appport/*` surface                           | Rust/Zig                     | No                     | No: AppPort's manifest already serves contracts            | —                                                                          |
| X mentions channel                                                                             | `personalOS/feltkit/xsurface.ts`                                                  | `x.test.ts`                                  | Dedup, durable cursor                                      | —                            | No                     | Not needed                                                 | —                                                                          |
| Provider layers, HTTP service and tenancy, OTel, ACP, MCP, web fetch, subagents, skills, evals | All projects                                                                      | —                                            | —                                                          | —                            | **Yes**                | No                                                         | —                                                                          |

## Remaining gaps

1. **Identity and authority.**
   - _Now:_ a shared-secret assertion with permissions in a JSON file.
   - _Recommended:_ `@authboundry/local`. Register the eve agent as an AuthBoundry agent, let people grant capabilities, and have the AppPort host authorize with `check(capability, on_behalf_of, { agent })`. That gives revocation, expiry, and a `delegation_id` for provenance.
   - Needs a decision; it adds a supervised native server. Exempt `@authboundry/*` from the release-age gate as for `@appport/*`.
2. **FeltDB is not wired.** Provenance lives in JSONL plus eve's Workflow world. The natural first FeltDB use is the provenance and intent record per AppPort invocation, as a `TelemetrySink` writing to FeltDB. Defer until the first consequential capability needs reconciliation.
3. **Republish `@appport/client` and `@appport/protocol`** so `authorizationDecision` reaches callers.
4. **Resolver is not used.** Runtime dependency resolution isn't needed for one HTTP endpoint.
5. **Only one read-only capability.** No consequential capability, so approvals and idempotent effects are not exercised yet.
6. **Single process.** The local Workflow world needs one `eve start` per directory.
7. **No restart supervision** beyond the operator's process manager.

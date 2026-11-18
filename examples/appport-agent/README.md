# AppPort agent example

A minimal, self-hosted eve agent that acts for an authenticated person through one AppPort capability, under that person's AuthBoundry delegation. It needs no Vercel account or service.

- **Model.** `anthropic("claude-sonnet-5")` direct (`ANTHROPIC_API_KEY`), overridable with `APPPORT_AGENT_MODEL`.
- **Tools.** `defaultTools: false`. The agent has only `appport_capabilities`, `appport_contract`, and `appport_invoke`.
- **Route auth.** `jwtHmac` (HS256; `AGENT_JWT_SECRET`, `AGENT_JWT_ISSUER`, `AGENT_JWT_AUDIENCE`), then `placeholderAuth()`.
- **Execution state.** eve's local Workflow world in `.eve/.workflow-data` (SQLite): sessions, turns, checkpoints. Sessions continue after a restart.
- **Work state.** FeltDB (`@feltdb/core` agent state, local file runtime) in `APPPORT_AGENT_WORK_DIR`. This is the authoritative record of each piece of work, independent of eve's sessions.

## How a capability call is authorized

Authentication, delegation and capability authorization are separate steps, each with its own owner.

1. **The person.** eve verifies the caller's JWT. The verified principal, for example `appport-agent-operator:alice`, becomes `ctx.session.auth.current`. The model never supplies it.
2. **The agent.** The tool calls AppPort with `@appport/client` at `APPPORT_URL` (`…/appport`). It sends the agent's AuthBoundry credential as `Authorization: Bearer` and the person as `x-appport-on-behalf-of`.
3. **Authentication at AppPort.** The host's `authenticate` hook accepts the request only when the credential equals the one the application holds for `agent:appport-agent`. That proves which agent is calling and grants nothing.
4. **Delegation.** The host's AppPort `Authorizer` asks AuthBoundry for each permission the capability declares:
   - it uses `POST /_authboundry/authorize/check` with the agent's credential and `on_behalf_of`;
   - it allows only on `allow`, which comes with the person's `delegation_id`;
   - any other answer is `FORBIDDEN` (`delegation_missing`, `delegation_revoked`, `delegation_expired`, and so on);
   - if AuthBoundry is unreachable the call fails closed (`INTERNAL_ERROR`).
5. **Exposure.** Only capabilities listed in `APPPORT_AGENT_CAPABILITIES` are ever sent (the default lists only `catalog.lookup`). A capability that is not `effect: "observation"` is sent only as a durable operation within accepted work; see [Durable operations](#durable-operations).
6. **Provenance** goes to `APPPORT_PROVENANCE_FILE`, joined by `requestId`:
   - `authorization`: agent, person, decision, `decisionId`, `delegationId`, reason;
   - `execution`: written by the handler, only when it ran;
   - `request`: AppPort's own telemetry.

## Durable work

Submit work to `POST /work`, authenticated with the same JWT as the eve channel and an `Idempotency-Key` header:

```bash
curl -X POST "$AGENT_URL/work" -H "authorization: Bearer $JWT" -H "idempotency-key: order-123" \
  -H "content-type: application/json" -d '{"objective":"How many units of SKU ALPHA-1 are in stock?"}'
# 201 {"workId":"work_…","sessionId":"wrun_…","replayed":false}
curl "$AGENT_URL/work/work_…" -H "authorization: Bearer $JWT"
```

**What `POST /work` does:**

1. **Authenticate** with eve's `routeAuth` and `jwtHmac`.
2. **Record the submission.** Derive the work id from (requester, key) and commit a `work_submissions` record first: the objective and the caller's verified `AuthResult`. JWT claims only, never the token.
3. **Create the record.** Create a FeltDB `AgentTask` with:
   - `objective`;
   - `owner` = `agent:appport-agent`;
   - `scope.workspace` = the requester;
   - `scope.project` = `inventory`.
4. **Start the session.** Send the objective to the eve session at address = work id, with eve's delivery `idempotencyKey`.

**Repeated submissions.** The same key and objective return the same work and session and run nothing again. The same key with a different objective returns `409 IDEMPOTENCY_KEY_REUSED`.

**Progress** is recorded by the `work` channel's event handlers as immutable FeltDB checkpoints, never overwritten:

| eve event                           | Checkpoint                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.started`                      | `running`, with the eve session id as `execution.conversation_id`; the session is bound to the work in `work_sessions` before any tool runs |
| `call.settled` for `appport_invoke` | `running`, citing the invocation record as evidence (verified by FeltDB inside the commit)                                                  |
| `turn.settled`                      | One of the three outcomes below, decided from recorded evidence, never from the model's text                                                |

| Outcome                                                                               | When                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `completed`                                                                           | At least one invocation was authorized                                                             |
| `blocked` with `waiting: every AppPort invocation was rejected`                       | Every invocation was rejected                                                                      |
| `blocked` with `failed: the eve turn ended failed`                                    | The turn failed                                                                                    |
| `blocked` with `indeterminate: N AppPort operation(s) without an established outcome` | An `appport_invoke` call settled while its operation's outcome is unknown (see Durable operations) |

The agent's reply is kept in the summary as the agent's claim.

**Invocation evidence.** Each call is a durable operation (below). The work cites `appport_operations` records, never model text. AppPort's `traceId` is the work id, so the host's provenance carries the work id beside the AuthBoundry `delegationId`, `decisionId` and authority.

**Reading work.** `GET /work/:id` returns a requester's own work only; anyone else gets 404. The response includes status, history, decisions, evidence, invocation outcomes, the recorded session, and the session eve currently holds for that address.

Only one eve process may open the work store: FeltDB holds an exclusive lock.

## Durable operations

Within accepted work, every `appport_invoke` call is a durable operation in the FeltDB work store (`appport_operations`). Each eve call is linked to its operation, or recorded as refused, in `appport_invocations`.

**Identity.** `op_` + SHA-256 of (work id, capability, then either `operationKey` if the model passed one, or the RFC 8785 canonical digest of capability, version and input).

- A repeated call with the same input, or the same key, resolves to the same operation. That includes a call the model re-issues after eve abandoned an interrupted one.
- Different input is a different operation.
- The same key with different input or capability is refused as `OPERATION_CONFLICT`, and the recorded intent is never overwritten.
- eve call ids and AppPort request ids are **not** used as identity: neither is stable across retries.

**Lifecycle.**

```
prepared ─▶ executing ─▶ succeeded | failed | indeterminate
```

1. `prepared` is committed, and the call linked, before anything is sent.
2. `executing` is committed, naming this process, before the request is sent.
3. The request is sent with the operation id as AppPort's `idempotencyKey`, when the manifest declares `idempotency: "supported"`.
4. The outcome is committed from AppPort's actual response.

Transitions are compare-and-set on the record version.

**Repeated attempts.**

| Recorded state                          | What happens                                                          |
| --------------------------------------- | --------------------------------------------------------------------- |
| `succeeded`, `failed`                   | The recorded outcome is returned; nothing is sent                     |
| `indeterminate`                         | Returned as `OPERATION_INDETERMINATE`; never sent again automatically |
| `prepared`                              | Sent: nothing was sent before                                         |
| `executing` from a process that is gone | Depends on the downstream guarantee (next table)                      |

| Downstream guarantee (from the AppPort manifest) | `executing` after an interruption                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotency: "supported"`                       | Sent again with the **same** key. AppPort replays the recorded response, so the effect does not run again. An `IDEMPOTENCY_OUTCOME_UNKNOWN` answer becomes `indeterminate` |
| `effect: "observation"` (no effect declared)     | Sent again (a repeated read)                                                                                                                                               |
| Neither                                          | `indeterminate`, with a resolution note. A person must establish whether it took effect                                                                                    |

**How answers are classified.**

- An answer that proves the capability did not run is `failed`, and is not retried: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT`, `INVALID_REQUEST`, `NOT_FOUND`, `UNKNOWN_CAPABILITY` or `UNSUPPORTED_CAPABILITY_VERSION`.
- Any other error is `indeterminate`.
- An unreachable AppPort leaves a keyed or observation operation reconcilable by a later attempt. An operation with neither guarantee becomes `indeterminate`.

**Not guaranteed.**

- **Exactly-once effects.** The downstream key gives at-most-once execution of the handler, and the example host keeps its keys in a durable store (below). A durable claim and the capability's external effect are still not one transaction.
- **Calls outside accepted work.** Consequential capabilities are refused outside accepted work.
- **A model that changes the input on retry.** That creates a new operation.

## Durable AppPort idempotency

The example host replaces AppPort's in-memory idempotency store with `appport-host/idempotency-store.mjs`. It implements AppPort's own `IdempotencyStore` interface (`get`, `set`, `claim`, `release`, `findByRequestId`) on a FeltDB collection in `<APPPORT_HOST_DATA_DIR>/idempotency`. AppPort's runtime is unchanged.

**Key scope.** AppPort scopes a key to `<session>|<capability>@<version>|<key>`. The host derives one AppPort session per (agent, person), so:

- a key never answers another person's request;
- a key never answers another agent's request;
- an unauthenticated request never reaches the store.

**Records.** One record per scoped key: `in-progress` (claim), `completed` (response), or `released`. Each record holds:

- the capability and version;
- AppPort's request digest (canonical capability, version and input);
- the claiming `requestId`, session and principal;
- the host instance (`owner`) that wrote it.

| Store operation | FeltDB write                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| claim           | Create-if-absent (`requireAbsent`); a `released` record is re-claimed by compare-and-set                     |
| set (completed) | Compare-and-set on the claim of the same `requestId`; another request's claim or record is never overwritten |
| release         | Compare-and-set to `released`, only for the same `requestId`                                                 |

**What a repeated request gets.** AppPort's runtime decides this from the stored record:

| Stored                                           | Repeated request                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Nothing                                          | Claimed, then executed                                                                     |
| `completed`                                      | The stored response is replayed (`idempotentReplay: true`), including after a host restart |
| `in-progress`, live or abandoned                 | `CONFLICT` / `IDEMPOTENCY_OUTCOME_UNKNOWN`; not executed                                   |
| Different capability, version or input           | `CONFLICT` / `IDEMPOTENCY_KEY_REUSED`; not executed                                        |
| `released` (the handler threw, or never started) | Claimed again and executed. AppPort treats a throwing handler as having had no effect      |

**Deliberate difference from the interface comment.** AppPort's interface says an expired entry counts as absent (24-hour TTL). This store never expires anything, so an abandoned claim stays uncertain until a person resolves it, instead of becoming executable after a day. Retention is left to the operator.

**One host per store.** FeltDB's exclusive lock refuses a second host on the same data directory with `STATE_LOCKED`; the host opens the store before it starts AuthBoundry.

## Recovery

eve has no startup hook. The `work` channel therefore reconciles every unfinished work record (`ready`, `running`, `blocked`) once per process, before it answers its first `/work` request. `POST /work/reconcile` forces another pass; only the principal named by `APPPORT_AGENT_OPERATOR` may call it.

Run it right after start: from the supervisor (for example a systemd `ExecStartPost`), or by sending any `/work` request.

For each record, the reconciler reads eve's recorded events in process (`sessions.attach(id).stream({ follow: false })` from `eve/server`), folds them with `eve/events` selectors, and decides:

| eve shows                                                    | Work becomes                                                                                 | Runs anything?               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------- |
| No session for the work, record `ready`, submission recorded | Submitted at its address with the original delivery key; decision `recovered: submitted…`    | Yes: the accepted turn, once |
| No session, record not `ready`, or no submission record      | `blocked`, `indeterminate: …`                                                                | No                           |
| A turn still running                                         | `running`; eve's own world resumes it                                                        | No                           |
| A turn waiting on an interaction (approval)                  | `blocked`, `waiting: …`                                                                      | No                           |
| A settled turn                                               | The live outcome rule, prefixed by `recovered: final state reconstructed from eve session …` | No                           |
| A session that cannot be read                                | `blocked`, `indeterminate: eve session … could not be read`                                  | No                           |

**Idempotent.** A pass writes only when the derived status or decision differs from the record, so repeated passes change nothing.

**No invented evidence.** Evidence comes only from committed invocation records belonging to that work. A settled `appport_invoke` call without one makes the work indeterminate.

## Who owns what

| Concern                                      | Owner                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| AuthBoundry server process and its state     | The AppPort application (`appport-host/host.mjs`), via `@authboundry/local`      |
| Grants and revocations                       | AuthBoundry, through the application (`authority.grant` / `authority.revoke`)    |
| The agent's credential (issue, renew, store) | The application, written to `APPPORT_AGENT_CREDENTIAL_FILE` (mode 0600)          |
| Reading the current credential               | eve, from the same file, on every call                                           |
| Work records, progress, outcomes, evidence   | FeltDB, written by the eve agent (`agent/lib/work.ts`, `agent/channels/work.ts`) |
| Sessions, turns, execution checkpoints       | eve's Workflow world; never the work record                                      |

The agent never sends AuthBoundry a credential of its own. A renewed credential supersedes the old one, and replaying a superseded credential revokes the whole family (verified). So the application keeps custody and compares what the agent presents with its current copy.

## Run it

```bash
pnpm install
AUTHBOUNDRY_ADMIN_SECRET=<32+ chars> APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_PORT=4317 pnpm appport-host
EVE_MODEL_CATALOG=bundled pnpm build
ANTHROPIC_API_KEY=… AGENT_JWT_SECRET=<32+ chars> APPPORT_URL=http://127.0.0.1:4317/appport \
  APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_AGENT_CAPABILITIES=catalog.lookup APPPORT_AGENT_WORK_DIR=$PWD/.appport-agent-work pnpm start
```

The host keeps AuthBoundry's state and its check credential in `APPPORT_HOST_DATA_DIR` (default `.appport-host`).

Run the host under a supervisor that stops its whole process group (for example systemd's default `KillMode=control-group`). If the host is killed abruptly, the AuthBoundry server it started keeps running.

People grant through the application. This example has no person-facing grant screen; the tests grant and revoke with `host.authority`.

## Tests

`pnpm test` runs `node --test`.

**Always**, with real AppPort and AuthBoundry servers and no model:

- discovery and the capability's contract;
- no grant → `delegation_missing`;
- Alice's grant → a result equal to `catalog.json`, with the delegation in provenance;
- Bob can't use Alice's grant;
- invalid input is rejected;
- revocation stops the next call, and a new grant gets a new id;
- an expired grant is rejected;
- a forged agent credential gets `UNAUTHORIZED`;
- an AuthBoundry outage fails closed, then calls recover after the automatic restart;
- an AppPort outage is a failure, never a result;
- unexposed capabilities are never sent;
- grants and credentials survive a restart of the application.

Every rejected call is checked to have no `execution` record.

**Always, `test/work.test.mjs`.** Real eve (`eve start`), FeltDB on disk, AppPort and AuthBoundry, with a scripted `mockModel` agent generated from `agent/` with only `agent.ts` replaced:

- one record per submission, and the actual outcome;
- AppPort provenance linked to the work and the delegation;
- idempotent replay, and a key-reuse conflict;
- Bob can't read Alice's work;
- revocation blocks invocation;
- a failed turn is recorded as failed;
- the record and session association survive an eve restart (whole process group killed);
- the records read directly from FeltDB without eve;
- recovery after process-group crashes:
  - between record creation and send;
  - after AppPort answered but before the evidence was written;
  - before the final checkpoint;
- a failed checkpoint write stays visible until reconciliation;
- a call without committed evidence is never cited;
- durable operations, with test-only `probe.applykeyed` (`idempotency: "supported"`) and `probe.applyunkeyed` capabilities that count their effects:
  - intent is committed before invocation;
  - a crash after the effect is replayed through the key once (keyed) or becomes indeterminate (unkeyed), and is never repeated;
  - indeterminate stays indeterminate across recovery passes;
  - repeats, conflicts, distinct operations, failures and Bob's authority are covered;
- **Always, `test/idempotency.test.mjs`.** The host runs as its own process (`test/probe-host.mjs`, effects appended to a file). Each restart test kills the host and AuthBoundry, checks both are gone, reads the host's FeltDB records directly, and starts a new host on the same store. It covers:
  - completed replay after a restart;
  - key reuse with changed input;
  - a crash after the claim;
  - a crash after the effect but before the response;
  - concurrency;
  - a second host refused;
  - per-person key scope;
  - no claim for an unauthenticated caller;
  - eve's ledger replaying through the durable store after both eve and the host restart;
- waiting work stays waiting;
- reconciliation run twice changes nothing;
- a replayed key after restarts runs nothing;
- a missing eve session is never reported as completed.

The scripted agent replaces `agent/lib/faults.ts` (a no-op in the real agent) to crash or fail at named points, and adds an approval-gated tool.

**With `APPPORT_AGENT_E2E_ANTHROPIC_API_KEY`**, the built agent on `eve start` with a real model:

- an unauthenticated request gets 401;
- Alice's answer comes through her delegation;
- the same session continues after a kill and restart;
- Bob is rejected.

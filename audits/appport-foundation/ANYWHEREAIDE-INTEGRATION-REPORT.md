# AnywhereAide integration (slice 6)

**Result.** A linked person's request from Multiplayer or X now reaches the eve AppPort agent and runs under that person's own AuthBoundry grants to the agent:

```
surface → Personal OS (identity) → eve /work → AppPort → FeltKit delegated /appport → AuthBoundry → Personal OS's own code
```

The answer comes back through each surface's existing outbound path, to the conversation or post the request came from.

**What was added:**

- one Personal OS module (`feltkit/anywhere.ts`);
- one integration;
- one internal agent;
- an identity-authority path in eve's existing work channel.

**What was not added:** a messaging service, an identity service, a queue, or a new agent.

| Repository                                                       | Branch                         | Change                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rkendel1/personalOS` (from `c1c8b00`, now `28c4573`, `3c3e3c2`) | `claude/dreamy-galileo-4z03p5` | `feltkit/anywhere.ts`; the `agent` integration, `anywhere` role, `AgentWork` record and job route (`feltkit/app.ts`); hand-off branches in `interactions.ts` and `xsurface.ts`; `docs/ANYWHERE.md` |
| `rkendel1/eve2` (from `c512f36`)                                 | `claude/dreamy-galileo-4z03p5` | Identity-authority submissions and lookup (`agent/channels/work.ts`), provenance on submissions (`agent/lib/work.ts`); `test/anywhere.test.mjs`; harness additions; this report                    |
| `rkendel1/feltkit`                                               | unchanged                      | —                                                                                                                                                                                                  |

**Starting state, verified:**

- Personal OS `340045a` is on Personal OS main (PR #30, `c1c8b00`).
- eve2 `ed36d92` is on eve2 main (PR #15, `c512f36`).
- Neither main had newer work, so both branches were fast-forwarded to main before the changes.

## Surfaces as they are (inspected)

|                                 | X (`@anywhereaide` bot)                                                                                                                                                                                                                  | Multiplayer (bridge)                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound                         | `x.poll` job reads mentions with the bot's OAuth token (FeltKit custody, refreshed), then `xsurface:receive` per mention                                                                                                                 | The bridge, an operator-issued `bridge` session, calls `interactions:receive` with a `personalos.interaction/1` envelope                                                                                                                                             |
| Sender identity                 | X's numeric author id, from X's API (the only identity used)                                                                                                                                                                             | `sender.sourcePrincipalId`, authenticated by the bridge; the session id must equal `source.adapter`                                                                                                                                                                  |
| Resolution                      | Resolver: `(x, x.com, authorId)`, then the person; `NOT_LINKED` / `AMBIGUOUS_IDENTITY` refused                                                                                                                                           | Resolver: `(adapter, instance, sourcePrincipalId)`, then the person; same refusals; a `revoking` link is refused at once                                                                                                                                             |
| Inbound idempotency             | `xPosts` unique by post id                                                                                                                                                                                                               | `interactions` unique by `adapter:idempotencyKey`                                                                                                                                                                                                                    |
| Outbound                        | Personal OS posts as the bot (`x.reply` job; claim/settle: `pending → sending → sent / failed / unknown`; an unclear post is never retried blind; 429 backs off). **Only a generic public acknowledgement**; results stay in Personal OS | Personal OS appends a numbered update and emits `interaction.updated`, which names the interaction only. The bridge fetches it with its own session (`interactions:status`, refused once the link is revoked) and posts it to the conversation the message came from |
| Authorization before this slice | AuthBoundry decides each request's capability for Personal OS's executor on behalf of the person                                                                                                                                         | Same                                                                                                                                                                                                                                                                 |
| Chrome, iOS                     | Sign in as the person (Personal OS sessions). No external identity, and no hand-off is added                                                                                                                                             |                                                                                                                                                                                                                                                                      |

## Design

### Identity resolution and the response route

The open question from slice 5 was how eve gets a safe route back to the person. **It doesn't need one.** Personal OS keeps the route: the reply is written to the record the request arrived on. eve receives no recipient, and nothing eve returns names one.

| Requirement                                          | How                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Personal OS resolves identity                        | Unchanged slice-5 resolution in `interactions:receive` and `xsurface:receive`, before any hand-off                                                                                                                                                                                                           |
| Resolver keys stay in Personal OS                    | eve receives only the Resolver _reference_ and revision, as provenance. Test 6/8 scans eve's answers and its whole store for both key secrets                                                                                                                                                                |
| eve does not accept a caller-supplied person         | Only a token signed by the identity authority's key (ES256, issuer `APPPORT_AGENT_IDENTITY_ISSUER`, audience `appport-agent-identity`) may carry `onBehalfOf`:<br>• a requester's own token naming someone: `403`;<br>• a token signed by another key: `401`;<br>• the authority without `onBehalfOf`: `400` |
| Bound to the verified identity and person            | The surface record holds the event, the sender and the Resolver result. eve's submission holds `assertedBy` and the same provenance. Personal OS submits `onBehalfOf: record.owner`, where `owner` is set from Resolver's answer                                                                             |
| Destination derived from the inbound context         | `report()` writes to the record by id. Multiplayer's bridge posts to that envelope's `respondTo`; X has only the acknowledgement to the inbound post id                                                                                                                                                      |
| Unlinked, revoked, ambiguous or unverifiable refused | Before any hand-off (test 3-5); the authority unreachable gives `UNAVAILABLE` with nothing recorded                                                                                                                                                                                                          |

**Credential custody:**

- **Personal OS:** the identity token is the FeltKit credential `agent-identity`. Its integration is `expose: false`, except the lookup probe (below). Only the `anywhere` agent's role holds `anywhere.agent`.
- **eve:** holds Personal OS's public key, never a Personal OS secret.
- **Resolver keys:** stay in FeltKit custody.
- **X:** the bot's OAuth credential stays in FeltKit custody.
- **Multiplayer:** the bridge keeps its own posting credential.

### Delegated execution

1. Personal OS asks AuthBoundry `personalos.assistant.converse` for the person: "take my requests from surfaces". Refused means nothing is sent to eve (authority test).
2. eve accepts the work as `<requester issuer>:<person>`, the same requester as the person's own direct submissions. The person is the on-behalf-of identity of every AppPort call.
3. Each call goes to Personal OS's delegated `/appport`. There AuthBoundry decides that capability for agent `appport-agent` on behalf of the person (slice 2.0).

**Consequences:**

- No grant, a missing capability, or a revoked grant each gives `FORBIDDEN` at the operation, and the work is blocked (tests 10-12).
- A link grants nothing.
- Read-only submissions, contract pinning, the ledger, the completion gate and reconciliation are eve's unchanged slice-4 code (tests 14/15).

### Inbound event → work

| Step                                                     | Durable record                                                                                                                                                                                    | Duplicate or crash behaviour                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider event accepted                                  | `interactions` (or `xPosts` plus `invocations`), with `agent = { key, state: "submitting", objective, surface }`, in the receive transaction                                                      | Redelivery returns the stored record (`replayed`)                                                                                                                          |
| Hand-off started                                         | `afterCommit.agent("anywhere")`, FeltKit's outbox, retried                                                                                                                                        | Exists exactly when the record does                                                                                                                                        |
| Submitted to eve                                         | `POST /work` with `Idempotency-Key: surface:<event key>`                                                                                                                                          | eve maps `(person, key)` to one work id                                                                                                                                    |
| No definite answer (eve down, a crash, a cut connection) | FeltKit refuses to resend that key while the call is unknown                                                                                                                                      | `GET /submissions/{person}/{key}` (also the integration's declared `verify` probe) finds the work. Found means adopt it; not found means ask again later. **Never resent** |
| Followed                                                 | `anywhere.follow` job chain with backoff (≤ 60 s), running as the agent. Each job carries a token, so a retried job cannot fork the chain                                                         | Survives a Personal OS restart (test 17)                                                                                                                                   |
| Outcome                                                  | `agent.state`: `submitting`, `accepted`, `completed`, `blocked`, `refused` or `expired`, plus eve's own `status` and `decision` verbatim, and the operations (capability, id, state, request ids) | Blocked is reported once per decision and followed for up to 24 h: stalled, indeterminate, every operation refused, or not completed. An operator may still settle it      |

### Outbound delivery

- **Execution and delivery are separate records.**
  - Execution is `agent` on the surface record.
  - Multiplayer delivery is the interaction's update sequence and its `interaction.updated` events, which AppPort Services signs, retries and records per delivery.
  - X delivery is the reply's claim/settle state.
- **Shared conversations:** only "done" or "not finished" is posted; the content stays in Personal OS.
- **X:** never gets the result.
- **Uncertain delivery stays uncertain.** An X reply in `unknown` is never retried, and nothing is reported "sent" without X's answer.
- **A delivery outcome never touches agent work.** The delivery code has no path to `anywhere`. Test 17/19 shows an unsent X reply leaves the same key and work id, and one project.

### Provenance chain (test 21/22 joins it end to end)

1. **Provider event:** Multiplayer `source.eventId` and `message.id`, or the X post id.
2. **Authenticated sender:** `identity.sourcePrincipalId`, or the X author id.
3. **Identity resolution:** `identity.resolverRef`, `resolverRevision` and `canonical`.
4. **Hand-off decision:** `interaction.authority`, the `personalos.assistant.converse` decision.
5. **eve work:** `agent.workId`. eve's `GET /work` adds `assertedBy` and `surface` (the same event id and Resolver reference).
6. **AppPort operation:** the eve ledger's `operationId`, `capability`, `requestIds` and `contractDigest`.
7. **FeltKit audit record of the delegated call:** found by request id. It carries `authority.delegation.decisionId` and `delegationId`.
8. **Personal OS action log:** the entry with that `decisionId`.
9. **Outbound:** the interaction update `seq` (Multiplayer), or `xPosts.replies[i]` status and `replyPostId` (X).

## Acceptance tests

eve2 `examples/appport-agent`:

```bash
FELTKIT_SDK_DIR=/path/to/feltkit/packages/sdk PERSONALOS_DIR=/path/to/personalOS node --test --test-concurrency=1 test/anywhere.test.mjs
```

**Result:** **14/14 passed**, with no AuthBoundry or Resolver processes left.

**Real:** eve (`eve start`, scripted model), the Personal OS server process with its own sources, `@authboundry/local`, the Resolver server process, and FeltDB.

**Stand-ins (labelled in the file):**

- The test plays the Multiplayer bridge, with a real operator-issued `bridge` session.
- The test plays the X adapter's poll, with a real `xadapter` session handing `xsurface:receive` a mention.
- No X API is involved.

| #     | Criterion                                    | Test                                                                                                                                                                       |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Linked X identity → correct person           | "1, 13, 21" (projects.create from an X mention completes as Ada's)                                                                                                         |
| 2     | Linked Multiplayer identity → correct person | "2, 9, 13, 18, 21"                                                                                                                                                         |
| 3–5   | Unlinked, revoked, ambiguous refused         | "3, 4, 5" (ambiguous via a second reference planted in Resolver); nothing reaches eve                                                                                      |
| 6     | Caller-supplied person cannot override       | "6, 8" (claimed e-mail, name and person; a requester token naming Grace `403`; a foreign signing key `401`)                                                                |
| 7     | Model or text cannot change the recipient    | "7, 18" (the request names Grace's conversation: no update lands on any of Grace's interactions)                                                                           |
| 8     | Resolver credentials never leave Personal OS | "6, 8" (scan of eve's answers and store)                                                                                                                                   |
| 9     | An authorized request creates eve work       | "2, 9, …"                                                                                                                                                                  |
| 10–12 | No grant; missing capability; revoked grant  | "10, 11, 12" (`FORBIDDEN` per operation; nothing created)                                                                                                                  |
| 13    | Existing implementations used                | tasks, projects (X), memory, documents, research, tasks.list; created records are Personal OS's own                                                                        |
| 14    | Read-only stays read-only                    | "14, 15" (an authority-submitted read-only work: `READ_ONLY_WORK`, empty ledger)                                                                                           |
| 15    | Contract drift still blocks                  | "14, 15" shows the surface's operation is pinned (`sha256:`). Blocking on drift is the same `runOperation` code, tested in `safety.test.mjs` (slice 4); not re-staged here |
| 16    | Duplicate provider events                    | "16" (Multiplayer redelivery and an X re-read: one task, one project)                                                                                                      |
| 17    | Crash during acceptance or recovery          | "17, 19" (Personal OS killed while eve is down; eve killed after its operation) and "17" (eve killed after accepting, before answering: found by key, done once)           |
| 18    | Reply only to the verified conversation      | "2…18", "7, 18"                                                                                                                                                            |
| 19    | Delivery failure does not repeat work        | "17, 19"; "21, 22" (same key and work id after the X reply failed)                                                                                                         |
| 20    | Uncertain delivery not reported successful   | "17, 19" (the X reply is not `sent`). The `unknown` reply state is tested against the X API stand-in in Personal OS `tests/x.test.ts` "12"                                 |
| 21    | Execution and delivery distinct              | "21, 22"                                                                                                                                                                   |
| 22    | Provenance joins every step                  | "21, 22"                                                                                                                                                                   |
| 23    | Direct behaviour unchanged                   | "23"; Personal OS full suite 166/166 (none skipped); eve suites 147/147 with FeltKit and Personal OS (the earlier 133 plus these 14), none skipped                         |
| 24    | No leaked processes                          | Process counts after each run: 0                                                                                                                                           |

Plus "authority": a person without `personalos.assistant.converse` is refused before eve; the bridge cannot run `anywhere:follow` and is refused on `/appport` for `agent.submit` and the lookup probe.

## Mutation checks

Each one is applied to the source, then `test/anywhere.test.mjs` is run and the source restored.

| Mutation                                                                                | Caught by                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Identity substitution (eve): any caller may name a person                               | "6, 8"                                                     |
| Identity substitution (Personal OS): the sender's claimed person is submitted           | "6, 8"                                                     |
| Recipient substitution: the reply is written to the conversation the request text names | "7, 18"                                                    |
| Authorization bypass: `personalos.assistant.converse` not enforced                      | "authority"                                                |
| Authorization bypass: the bridge role given `anywhere.agent`                            | "authority"                                                |
| Duplicate processing: a new agent key per attempt                                       | "17" (eve crash after accepting: two works), with cascades |
| Duplicate processing: redelivered provider events not recognized                        | "16"                                                       |
| Delivery-triggered replay: an unsent X reply hands the request over again               | "1, 13, 21"; "16"; "17, 19"; "21, 22"                      |

**All 8 are caught.**

The first form of the recipient mutation survived. It redirected only the `interaction.updated` _event_ to another interaction, and wrote the update to the right record. That is not a delivery: the event names an interaction, and the bridge fetches content with its own session, which shows nothing new. So that mutation was corrected to write the update elsewhere, and is then caught.

**Recorded as a finding:** an event naming the wrong interaction would make a bridge fetch an unchanged interaction. It is not tested, because the test registers no webhook endpoint.

## Surface coverage

|                              | X                                                                                                                                                                                                                               | Multiplayer                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider integration         | The X API v2 bot integration exists (OAuth 2.0 PKCE, FeltKit custody). **Not exercised against real X**: Personal OS `tests/x.test.ts` uses a labelled local stand-in; this slice drives intake as the X adapter, with no X API | The bridge is the Multiplayer repository's; Personal OS's side is real. **The bridge was played by this test**; Multiplayer's own e2e (`e2e/personalos-anywhere.e2e.mjs` in that repository) was not run |
| Stable sender id             | X numeric author id                                                                                                                                                                                                             | `(bridge id, installation, sourcePrincipalId)`                                                                                                                                                           |
| Resolution                   | Resolver, slice 5                                                                                                                                                                                                               | Resolver, slice 5                                                                                                                                                                                        |
| Inbound idempotency          | Post id, and eve key `surface:x:<post id>`                                                                                                                                                                                      | Interaction key, and eve key `surface:multiplayer:<key>`                                                                                                                                                 |
| Outbound                     | Generic acknowledgement (existing reply lifecycle); result in Personal OS                                                                                                                                                       | Interaction updates and the event the bridge already consumes                                                                                                                                            |
| Credentials                  | Bot OAuth in FeltKit; identity token in FeltKit                                                                                                                                                                                 | Bridge session (operator-issued); identity token in FeltKit                                                                                                                                              |
| Remaining provider-side work | A real X developer app and bot account; live posting and rate-limit behaviour are unverified                                                                                                                                    | Running Multiplayer's own e2e against this Personal OS                                                                                                                                                   |

## Limitations and deferred findings

- **Follow-up is by polling.** Personal OS polls eve's `GET /work`, at most every 60 s after backoff and for up to 24 hours. eve has no callback, and adding one would be new outbound messaging in eve.
- **Two grants are needed.** A person must allow `personalos.assistant.converse` (Personal OS taking surface requests) _and_ grant eve each capability. That is deliberate (consent to hand content to an agent, separate from what the agent may do), but it is two settings.
- **Surface hand-offs are never read-only.** Read-only is enforced by eve when the authority asks for it (tested), but no surface rule sets it today.
- **Contract drift is not re-staged.** It isn't re-staged against Personal OS's served manifest; the enforcement point is shared with slice 4's tests.
- **The objective is the message text only.** Thread context and referenced posts are not sent to eve. That is safer as data, but the agent sees less.
- **A submission with no definite answer that eve never received stays "submitting".** Its key cannot be resent until FeltKit's verification settles it. An operator can verify it (Studio; the probe is declared), or it expires after 24 hours. Personal OS app code cannot invoke FeltKit's verification. That is a FeltKit boundary, recorded rather than changed.
- **`waiting:` has two meanings in eve.** It is used both for "every invocation rejected" and for "waiting on an interaction". Personal OS matches the full text; eve could give the first its own prefix.

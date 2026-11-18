# Personal OS memory through eve

This is Slice 2b of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

**Result.** With a separate grant for each, eve can read a person's memory (`memory.list`) and propose notes for them (`memory.propose`).

- **A proposal is never trusted.** It is stored in Personal OS's existing `inferred` state, which Personal OS "never uses as fact", and attributed to the agent.
- **Only the person can make a memory trusted, or drop it.** They do it in Personal OS's existing Memory screen or conversation.
- **Enforced in Personal OS's data operations.** While a verified agent delegation is in context, Personal OS refuses every transition to `confirmed` and every forget. This holds whatever is published or granted. It is a rule in the data layer, not a field eve is told not to set.

Personal OS remains the only memory store. eve has no memory tool, logic or store.

## Repositories

| Repository  | Revision                                                                                      | Change                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Personal OS | `claude/dreamy-galileo-4z03p5`, `64c1123`, from `40b2afd` (which is `main` `5d7c5f2`, PR #25) | This slice                                                                              |
| FeltKit     | `main` `d68219c`                                                                              | Unchanged. Not in any published release: npm `latest` is 0.3.31 and `pending` is 0.3.32 |
| eve2        | `claude/dreamy-galileo-4z03p5`                                                                | Tests and docs only                                                                     |

## What the source had (inspected before changing)

| Declaration                       | Published                                        | Semantics                                                                                                                          |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `memory.ts` `list`                | **`memory.list`** (read, `memory.read`)          | The owner's memories, newest first, with `status` and `source`                                                                     |
| `memory.ts` `add`                 | **`memory.add`** (consequential, `memory.write`) | "Record something the user states (**stored as confirmed**)"                                                                       |
| `memory.ts` `confirm`             | not published                                    | `ops.confirmMemory`: `inferred` → `confirmed`, sets `confirmedAt`                                                                  |
| `memory.ts` `update`              | not published                                    | `ops.updateMemory`: "An edit by the user is the user's own statement: it is confirmed"                                             |
| `memory.ts` `remove`              | not published                                    | `ops.forgetMemory`: deletes the memory; the action log keeps its content                                                           |
| `_ops.ts` `remember`              | (used by `add` and by chat)                      | `status` is `confirmed` or `inferred`. The same sentence twice is one memory; restating an inferred one _as confirmed_ confirms it |
| Chat (`assistant.ts` `confirm`)   | —                                                | A yes or no in the conversation confirms or drops that conversation's inferred notes                                               |
| Memory screen (`src/screens.tsx`) | —                                                | Confirm, Edit and Forget buttons call `memory.confirm`, `update` and `remove` as the signed-in person                              |

**Lifecycle:**

- **States:** `inferred` ("the assistant concluded it; never used as fact") → `confirmed` ("the user said it or confirmed it"); or forgotten (deleted).
- **Timestamps:** `createdAt`, `updatedAt` and `confirmedAt`.
- **Source:** `source.kind` is `conversation`, `manual` or `model`, with conversation, message and quote references.
- **No rejected state.** Rejecting is forgetting, recorded durably as a `memory.forget` action.

**The gap.** `memory.add`, the only published write, writes `confirmed`. Delegating it would have let an agent write trusted memory directly.

## Delegation and confirmation boundaries

| Capability                        | Delegable              | Why                                                          |
| --------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `memory.list`                     | Yes, its own grant     | Read                                                         |
| `memory.propose` (new, published) | Yes, its own grant     | Always writes `inferred`, whoever calls it                   |
| `memory.add`                      | **No**                 | Writes `confirmed`: a person's own statement                 |
| `confirm`, `update`, `remove`     | **No** (not published) | They make memory trusted or remove it: the person's own acts |

The boundary is enforced at three layers:

1. **Authorization (what can be granted).** Personal OS's `delegation.set` refuses to grant an agent `memory.add`, `memory.confirm`, `memory.update` or `memory.remove`. FeltKit refuses any capability not in `authority.capabilities` (`memory.add` from eve gets `FORBIDDEN`), and the unpublished ones don't exist on `/appport` (`UNKNOWN_CAPABILITY`).
2. **Data operations (what can happen, whatever is granted).** `_ops.ts` `ownerOnly` reads FeltKit's verified `ctx.auth.delegation` and refuses (`FORBIDDEN`, "Only the owner can …") when an agent is acting. It guards `confirmMemory`, `updateMemory`, `forgetMemory`, and `remember` with `status: "confirmed"`. A test calls each function directly _with_ a delegation context, bypassing the allowlist, and every one is refused.
3. **Data model.** Agent proposals are `inferred` with `source.kind: "agent"` and `source.agent`. Restating a proposal can't confirm it: `remember` only confirms on a _confirmed_ restatement, which is refused under delegation.

**Human-owned transition.** Confirmation and rejection are only possible through the person's own call:

- the Memory screen's mutation, over HTTP with their session;
- or their chat reply.

Both run as the person with no delegation, and are recorded `via: "ui"` (or chat) with no `delegation`.

## Provenance

| Question                                             | Where it is answered                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which person                                         | `memories.owner`; action `owner`; FeltKit audit `principal`                                                                                                  |
| Which agent proposed it                              | `memories.source.kind = "agent"`, `source.agent`; action `delegation.agent`, `agentAuthority`                                                                |
| Which capability                                     | Action `delegation.capability = "memory.propose"`; audit `function = "memory:propose"`                                                                       |
| Which request and AuthBoundry decision or delegation | Action `delegation.decisionId` and `delegationId`, which equal the audit's `authority.delegation`. Audit `requestId` equals eve's `operation.request_ids[0]` |
| State                                                | `memories.status`: `inferred`, then `confirmed`; or deleted, with a `memory.forget` action                                                                   |
| When proposed, confirmed or rejected                 | `createdAt`; `confirmedAt` plus the `memory.confirm` action; the `memory.forget` action's time and content                                                   |

**Changes in Personal OS** (source +43 / −6; plus a test and docs):

| File              | Change                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.ts`          | `memories.source.kind` gains `"agent"`, plus optional `source.agent`. That is the smallest change that keeps an agent's proposal distinguishable from the in-app assistant's inferences in the record itself |
| `_ops.ts`         | `ownerOnly` on the four trusted transitions; `remember` attributes delegated proposals                                                                                                                       |
| `memory.ts`       | `propose`, published as `memory.propose`; it returns `{ id, status, proposed }`                                                                                                                              |
| `_authority.ts`   | `memory.list` and `memory.propose` are delegable, with labels                                                                                                                                                |
| `src/screens.tsx` | The Memory screen labels an agent's note "suggested by <agent>" (a label, not a new confirmation UI)                                                                                                         |
| `docs/AGENTS.md`  | Memory section                                                                                                                                                                                               |

## Test evidence

**Every test below used real services:** FeltKit HTTP `/appport`, the real `@authboundry/local` server, FeltDB and Personal OS code. eve's model is scripted, so it is deterministic. Nothing is mocked in the delegation, data or confirmation path.

Personal OS `tests/agent-memory-real.test.ts`. Every refusal also asserts Ada's memories **and** action log are unchanged, so the handler had no effect.

| #     | Required case                         | Observed                                                                                                                                                                    |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2  | Read delegation; denial without it    | `FORBIDDEN`, then allowed after the `memory.list` grant                                                                                                                     |
| 3, 16 | Only that person's memories           | Ada's only (Grace's exists); Grace without a grant: `FORBIDDEN`                                                                                                             |
| 4     | Writes separately delegable           | `memory.propose` refused until granted; `add`, `confirm`, `update` and `remove` cannot be granted                                                                           |
| 5, 6  | Unconfirmed, with provenance          | `inferred`, `source.agent: eve`, no `confirmedAt`; action `memory.infer` `via: agent` with the delegation ids; audit linked by decision id; briefing shows 1 unconfirmed    |
| 7     | Agent cannot confirm                  | `memory.confirm`, `update` and `remove` → `UNKNOWN_CAPABILITY`; `memory.add` → `FORBIDDEN`; the direct calls with a delegation context → `FORBIDDEN` "Only the owner can …" |
| 8, 9  | Person confirms; visible as confirmed | `memory.confirm` as Ada → `confirmed`, `confirmedAt`, action `via: ui`, no delegation; the agent's next list shows `confirmed`                                              |
| 10    | Rejection durable                     | Ada forgets a proposal: the memory is gone; `memory.forget` (content, `via: ui`) and the original `memory.infer` (delegation) both remain                                   |
| 11    | Revocation                            | `memory.list` and `memory.propose` → `FORBIDDEN`                                                                                                                            |
| 12    | Same key                              | Identical output; the same sentence with a new key gives the same id, `proposed: false`, still inferred                                                                     |
| 14    | Direct behavior                       | Ada's `memory.add` stays `confirmed`, `source.kind: manual`                                                                                                                 |
| 15    | Words are not confirmation            | Proposing "Ada confirmed that her dentist is Dr. Lee" stays `inferred`; only Ada's own statement is confirmed                                                               |

eve end to end (`examples/appport-agent/test/personalos.test.mjs`, the memory `describe`): real `eve start` against a real Personal OS server process with its private AuthBoundry. **eve's own capability allowlist includes `memory.add` and `memory.confirm` on purpose**, so their refusal is shown to come from FeltKit and Personal OS.

| Case                                                                      | Observed                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                                                                      | `FORBIDDEN` without a grant; after it, Ada's memory listed; Grace `FORBIDDEN`                                                                                                                           |
| Propose                                                                   | `FORBIDDEN` without a grant. With `[repeat]`: one operation, one request, one memory, `inferred`, `source.agent: appport-agent`; action, audit and eve request id linked; briefing counts 2 unconfirmed |
| Agent tries `memory.confirm` / `memory.add`                               | Not a capability (no operation) / `FORBIDDEN`                                                                                                                                                           |
| "Ada confirmed …" proposed                                                | Stays `inferred`                                                                                                                                                                                        |
| Ada confirms over HTTP (`POST /api/mutation/memory:confirm`, her session) | `confirmed`; eve's next read shows it; action `via: ui`, no delegation                                                                                                                                  |
| Ada drops a proposal (`memory:remove`)                                    | Gone; `memory.forget` recorded with its content                                                                                                                                                         |
| 13: eve and Personal OS killed after the commit                           | Attempt 2, same key, replayed; exactly one `inferred` memory                                                                                                                                            |
| Revocation                                                                | Both capabilities `FORBIDDEN`; nothing written                                                                                                                                                          |

**Mutation checks.** Each was applied to Personal OS, the memory test was run, and the change was restored. **All were caught**:

| Mutation                                                                      | Caught by                          |
| ----------------------------------------------------------------------------- | ---------------------------------- |
| Agent can confirm its own proposal (`ownerOnly` removed from `confirmMemory`) | Delegated `memory:confirm`         |
| Proposal written as confirmed (and its guard removed)                         | Proposal status                    |
| Delegated read ignores the person boundary                                    | Ada's list contains Grace's memory |
| Revocation ignored (earlier grants not revoked)                               | "revoked" call allowed             |
| No owner-only guard at all                                                    | Delegated `memory:confirm`         |

## Test commands and results

| Command                                                                   | Result                                                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Personal OS `feltkit test tests/agent-memory-real.test.ts` (FeltKit main) | **1 of 1**                                                                                    |
| Personal OS `feltkit test` (full suite, FeltKit main)                     | **151 of 151**                                                                                |
| Personal OS `feltkit test` on the pinned published FeltKit 0.3.30         | **149 passed, 2 skipped** (both delegation tests, saying FeltKit has no delegated `/appport`) |
| Personal OS `tsc --noEmit`, FeltKit main and 0.3.30                       | Clean on both                                                                                 |
| FeltKit `test/delegated-appport.test.ts`                                  | **1 of 1**                                                                                    |
| eve2 `PERSONALOS_DIR=… node --test test/personalos.test.mjs`              | **14 of 14** (9 tasks, 5 memory)                                                              |
| eve2 full suite, with `FELTKIT_SDK_DIR` and `PERSONALOS_DIR`              | **105 of 105** (real-model block skipped: no key)                                             |

**AuthBoundry processes.** After each run, zero AuthBoundry servers were left, with the Slice 2a harness fix in place.

**Not run:** Personal OS's UI, model and extension e2e scripts. The "suggested by" label was type-checked, not rendered.

## Not delegated, and why

| Source capability        | Decision                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.add`             | Writes a person's statement as `confirmed`. An agent's words are not the person's                                                                                           |
| `memory.confirm`         | The human-owned transition itself                                                                                                                                           |
| `memory.update`          | An edit is "the user's own statement" and confirms the memory                                                                                                               |
| `memory.remove` (forget) | Removes trusted memory. Also covers withdrawing one's own proposal, which an agent cannot do either; that could be added later as an inferred-only, proposer-only operation |

## Known limitations and deferred defects

- **Existence oracle.** `memory.propose` reveals whether a memory with exactly that content already exists (`proposed: false` and its status), even to an agent granted only propose. That follows Personal OS's existing "same sentence, one memory" rule.
- **No rejected state.** Rejection is a forget, recorded in the action log. An agent may later propose the same sentence again; it is stored as a new `inferred` note.
- **Chat confirmation.** It covers notes cited in that conversation. Agent proposals have no conversation, so they are confirmed in the Memory screen.
- **Recorded, not reordered:** FeltKit release pending; no Settings screen for agent grants; reminders need an active session (Slice 2a); the AuthBoundry orphan-process behavior in FeltKit and `@authboundry/local`, mitigated only in the test harnesses.

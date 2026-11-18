# Personal OS tasks, reminders and daily briefing through eve

This is Slice 2a of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

**Result.** The eve agent lists, creates, updates, completes and reopens a person's Personal OS tasks, and reads their daily briefing, each capability only once that person has granted it to that agent.

- **Same code path:** Personal OS's own code runs every call as the person, through the FeltKit delegated path from Slice 2.0.
- **Reminders stay Personal OS's:** they are its own jobs, and fire with eve stopped.
- **Records:** every delegated write is recorded by Personal OS with the agent, the capability and AuthBoundry's decision and delegation ids, linked to eve's operation through FeltKit's audit record.
- **Deleting a task is not delegable.** That is Personal OS's own rule, and it is kept.

eve gained no task logic, no tools and no store.

## Repositories and revisions

| Repository  | Revision                                                                           | Role                                |
| ----------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| FeltKit     | `main` at `d68219c`: PR #142 merged `fca9fcb` (Slice 2.0). Unchanged in this slice | Delegated `/appport`                |
| Personal OS | Branch `claude/dreamy-galileo-4z03p5` (`40b2afd`) from `main` `c684688`            | The application and source of truth |
| eve2        | `claude/dreamy-galileo-4z03p5`                                                     | The consumer                        |

**No published FeltKit has delegated `/appport` yet.** npm `latest` is 0.3.31 and `pending` is 0.3.32. I unpacked both 0.3.32 and 0.3.23 and checked the files: neither contains `runtime/delegation.js` or the on-behalf-of header. 0.3.32 was published before PR #142 merged.

**Consequences:**

- Personal OS still pins `@feltdb/feltkit` 0.3.30, and its changes type-check and pass there; the delegation test skips there, saying why.
- The delegated behavior was run against FeltKit main, linked into Personal OS's `node_modules`.
- A FeltKit release from main is the remaining prerequisite for running this from published packages.

## What was inspected

| Area                      | Finding                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Published task contracts  | `tasks.list`, `tasks.create`, `tasks.update`, `tasks.complete` and `briefing.today` were published (`feltkit/tasks.ts`, `briefing.ts`)                                                                                                                 |
| Reopen and delete         | `reopen` and `remove` existed but were **not** published. `remove` carries the rule _"Deleting from the Tasks screen is the person's own direct act; the assistant can only propose it."_                                                              |
| Task operations           | `_ops.ts` `createTask`, `updateTask`, `completeTask` and `reopenTask` write the task, read it back to verify it, and record an action in the same transaction                                                                                          |
| Reminders                 | `createTask` and `updateTask` enqueue a `reminder.fire` job **as the caller**, after commit, to run at `remindAt`. `reminders.ts` `fire` runs as the owner, fires only if the task is still open and still wants that reminder, and marks `remindedAt` |
| Action log                | `actions` records `via` (`chat`, `ui`, `model` or `job`). Capability calls recorded `ui`. Nothing recorded an agent                                                                                                                                    |
| AuthBoundry configuration | `authority.capabilities` listed only the `personalos.*` surface vocabulary                                                                                                                                                                             |
| Granting                  | Settings (`delegation.set`) granted only to Personal OS's own executor. **It also revoked every grant the person held**, so once per-agent grants exist it would have silently revoked a person's grants to eve                                        |
| Registering agents        | No Personal OS role held `feltkit.authority.agents`, so no operator could register an outside agent. FeltKit has no CLI for it                                                                                                                         |
| `@authboundry/local`      | Pinned at 0.1.0, which has no per-agent delegation (0.1.1 does)                                                                                                                                                                                        |

## Capabilities enabled

| Capability                     | Effect                             | Change                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.list`                   | read                               | Listed in `authority.capabilities`                                                                                                                                                                                                              |
| `briefing.today`               | read                               | Listed                                                                                                                                                                                                                                          |
| `tasks.create` (with reminder) | consequential, FeltKit idempotency | Listed                                                                                                                                                                                                                                          |
| `tasks.update`                 | consequential, idempotent          | Listed                                                                                                                                                                                                                                          |
| `tasks.complete`               | consequential, idempotent          | Listed                                                                                                                                                                                                                                          |
| `tasks.reopen`                 | consequential, idempotent          | **Published** (the existing `reopen` function, unchanged) and listed                                                                                                                                                                            |
| Delete                         | —                                  | **Not published, not grantable.** The source's rule is kept: an agent cannot delete a task with any grant. The completion criteria ask for "selectively … delete": that conflicts with Personal OS's stated design and needs a product decision |

Each capability needs its own grant. Reading never implies writing, and no grant implies deletion.

## Personal OS changes

Source: +89 / −28 lines across six `feltkit/` files. Also a test, a doc, and the dependency bump.

| File                              | Change                                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_authority.ts`                   | `AGENT_CAPABILITIES` (the six above) and their labels                                                                                                                                                                 |
| `app.ts`                          | `authority.capabilities` adds them; an `agent` role holding no permissions (for `feltkit session create --role agent`); `admin` may register agents; the action schema gains `via: "agent"` and optional `delegation` |
| `tasks.ts`                        | `reopen` published as `tasks.reopen`                                                                                                                                                                                  |
| `_ops.ts`                         | `record()` reads `ctx.auth.delegation` (FeltKit's verified context, never the input) and stores `via: "agent"` and `delegation`                                                                                       |
| `_delegation.ts`, `delegation.ts` | `set` and `list` take an optional `agent`. The executor's and each agent's grants are separate sets, which **fixes the cross-revocation**. `registerAgent` is operator-only                                           |
| `package.json`, lockfile          | `@authboundry/local` 0.1.0 → 0.1.1. npm also moved `@authboundry/core` 1.18 → 1.20 and re-hoisted `@appport/services` 0.20 and `@feltdb/core` 0.22 (previously nested under FeltKit)                                  |
| `docs/AGENTS.md`                  | Setup, what can be granted, how calls and records work                                                                                                                                                                |

## Action-log provenance

A delegated write's action record is written in the same transaction as the write:

```jsonc
{
  "kind": "reminder.create",
  "status": "succeeded",
  "via": "agent",
  "evidence": { "collection": "tasks", "id": "…", "verified": true },
  "delegation": {
    "agent": "appport-agent",
    "agentAuthority": "agent:appport-agent",
    "capability": "tasks.create",
    "decisionId": "…",
    "delegationId": "…",
  },
}
```

**The linkable chain** (asserted end to end):

```
eve operation.request_ids[0]
  = FeltKit audit.requestId
FeltKit audit.authority.delegation.decisionId
  = Personal OS action.delegation.decisionId   (and the delegation ids match)
```

**Separation is kept:**

- eve's ledger records intent, key and outcome.
- FeltKit's audit records the commit and its decision.
- Personal OS's action log records the domain action and its read-back evidence.

**Outcome evidence:**

- **Success:** comes from Personal OS's own read-back (`verified: true`) and is checked through its normal read path (`tasks:list`).
- **A refused call** writes nothing in Personal OS (the function never runs). It appears in eve's ledger (`failed`, the code) and FeltKit's activity log.

## Reminder ownership

| Requirement                          | Evidence                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uses the existing contract           | `tasks.create` and `tasks.update` with `due`, `time`, `tzOffset` and `reminder`; no new contract                                                                     |
| Firing owned by Personal OS          | The job is Personal OS's `reminder.fire`, queued after commit **as the person**, at `remindAt`                                                                       |
| Delegation checked for agent changes | Creating or moving a reminder is a `tasks.create` / `tasks.update` call, decided per call                                                                            |
| Fires without the agent              | eve was stopped and the job executed in Personal OS: `reminder.due` reached Ada's inbox, and the action `reminder.fire` was recorded `via: "job"` with no delegation |
| No duplicates on retry               | A repeated create with one key gives one task and **one** reminder job; moving a task arms one new job (the old one finds a different `remindAt` and does nothing)   |

**Finding (existing behavior, not introduced here).** FeltKit runs a person's durable work, reminders included, only while that person has an active session: the job's principal is resolved from sessions, and an account alone does not count. A person who acts only through eve and never signs in gets no reminders. The same holds for reminders the person sets themselves. The eve test signs Ada in once, as a real user would be.

## End-to-end evidence

**eve → Personal OS** (`examples/appport-agent/test/personalos.test.mjs`):

- **eve:** real `eve start` with the scripted model.
- **Personal OS:** a real server process (`test/personalos-host.mjs`) running Personal OS's own `feltkit/` sources through its installed FeltKit, with its private AuthBoundry and FeltDB on disk.
- **Agent credential:** a FeltKit agent session.
- **Requester:** named by the verified token's subject (`APPPORT_ON_BEHALF_OF=subject`).

| #    | Case                                                                 | Observed                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Read grant lists Ada's tasks                                         | Work completed                                                                                                                                                                                     |
| 2, 3 | Create grant creates in Ada's space, visible on the normal read path | One `Call the dentist`, owner ada, due tomorrow at 10:00                                                                                                                                           |
| 4    | Update and complete                                                  | Notes changed; `Pay rent` done                                                                                                                                                                     |
| 5    | Reopen only when delegated                                           | `FORBIDDEN` before, then reopened after the grant                                                                                                                                                  |
| 6    | No delete                                                            | `tasks.delete` is not a capability: no operation, task untouched                                                                                                                                   |
| 7, 8 | Grace (no grant) and Grace reaching Ada's task                       | `FORBIDDEN`; with her own `tasks.complete` grant, Ada's task id gives `NOT_FOUND` and Ada's task is unchanged                                                                                      |
| 9    | Revocation                                                           | `FORBIDDEN`                                                                                                                                                                                        |
| 10   | The same operation twice                                             | One operation, one request, one task, one reminder job                                                                                                                                             |
| 11   | eve and Personal OS killed after the commit                          | Attempt 2 with the same key gives the replayed answer; one `Renew passport`                                                                                                                        |
| 12   | Personal OS killed after committing, before recording its answer     | After restarts the retry gets `IDEMPOTENCY_OUTCOME_UNKNOWN`, so the operation is `indeterminate`; a reconcile pass sends nothing more; one `Book flights`. It stays open for an operator (Slice 1) |
| 13   | Briefing reflects eve's changes                                      | eve's briefing read shows `Pay rent` due today; after completion it is gone; it equals Ada's own briefing                                                                                          |
| 14   | Reminders                                                            | See "Reminder ownership"                                                                                                                                                                           |
| 15   | Records link agent, person, decision and outcome                     | Action `via: "agent"` with the delegation fields; audit `requestId` equals eve's request id; decision and delegation ids equal                                                                     |
| 16   | Direct use unchanged                                                 | Ada's own create is recorded `via: "ui"` with no delegation (Personal OS test)                                                                                                                     |

Case 12 needs Personal OS to die at a specific point. The harness kills the process on the next write to FeltKit's real idempotency store, after a plan file appears; the destination's probe host uses the same technique. Personal OS and FeltKit code are unchanged.

**Personal OS** (`tests/agent-delegation-real.test.ts`): real HTTP `/appport`, the real `@authboundry/local` server and real jobs.

| What                      | Observed                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Registration              | An operator registers Eve; Grace cannot                                                                                                   |
| Separate grant sets       | Ada's executor grant survives granting Eve; agents cannot be given `personalos.*` or `tasks.delete`                                       |
| Refusals                  | Every refusal leaves Ada's tasks **and** action log unchanged                                                                             |
| Reads and writes          | List; create with reminder (action record, audit, one job queued as Ada); update re-arms the reminder; complete; reopen only once granted |
| Repeated key              | Returns the same task; Grace's same key gives Grace's own task                                                                            |
| Reminder                  | Fires through the job with nothing of Eve's involved                                                                                      |
| Briefing                  | Reflects the changes                                                                                                                      |
| Revocation and direct use | Revocation applies; direct use is unchanged                                                                                               |

**Mutation checks** on the Personal OS test. Each was applied, run and restored, and **all were caught**:

| Mutation                                    | Caught by                                |
| ------------------------------------------- | ---------------------------------------- |
| Executor and agent grant sets not separated | "Ada's grant to PersonalOS is untouched" |
| Action log ignores `ctx.auth.delegation`    | Record fields                            |
| Any capability grantable to an agent        | Missing rejection                        |

## Test commands and results

| Command                                                                                                             | Result                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Personal OS: `feltkit test tests/agent-delegation-real.test.ts` (FeltKit main)                                      | **1 of 1**                                                                                          |
| Personal OS: `feltkit test` (full suite; FeltKit main; `tests/resolver` and `tests/authboundry` fixtures installed) | **150 of 150**                                                                                      |
| Personal OS: `feltkit test` on the pinned **published FeltKit 0.3.30**                                              | **149 passed, 1 skipped** (the new test: "the installed @feltdb/feltkit has no delegated /appport") |
| Personal OS: `tsc --noEmit` on FeltKit main and on 0.3.30                                                           | Clean on both                                                                                       |
| FeltKit main: `test/delegated-appport.test.ts`                                                                      | **1 of 1**                                                                                          |
| eve2: `PERSONALOS_DIR=… node --test test/personalos.test.mjs`                                                       | **9 of 9**                                                                                          |
| eve2: full suite with `FELTKIT_SDK_DIR` and `PERSONALOS_DIR`                                                        | **100 of 100** (91 earlier tests and the 9 above; the real-model block is skipped, no key)          |

**Not run:** Personal OS's `e2e/*.mjs` (UI, model, extension) and the real-model acceptance tests.

**Process leaks found and fixed in the harnesses.**

- **Cause:** when a test kills a FeltKit host process (a crash), the private AuthBoundry server FeltKit started survives in its own process group. Over this session 74 servers and 445 bridge processes accumulated and exhausted memory, which made one combined run fail and hang.
- **Fix:** both destination harnesses (`personalos-host.mjs`, `feltkit-host.mjs`) record their AuthBoundry PIDs, and the tests stop those groups along with the host.
- **Verified:** after the runs above, zero AuthBoundry servers remain.
- **Still open, outside this repository:** the underlying FeltKit/`@authboundry/local` behavior (no supervision of the child when its parent is killed) remains, as reported in the first side-effecting milestone.

**A first full Personal OS run** before its fixtures were installed failed on missing `tests/resolver` packages. Both fixture directories were installed as the tests instruct, after which all of them passed.

## Remaining limitations

- **FeltKit release:** delegated `/appport` is on FeltKit main only; Personal OS needs a release after 0.3.32 to use it from npm.
- **Delete:** not delegable, by Personal OS's existing design. Changing that is a product decision.
- **No Settings screen** for agent grants. People grant through `delegation.set` with `agent`; the existing screen still shows only the executor's grants.
- **Reminders need an active session.** As for all Personal OS reminders, FeltKit's durable-work rule applies (see the finding).
- **Requester identity:** the eve-to-Personal-OS mapping uses the requester token's subject as the Personal OS person id. Identity linking is a later slice.
- **Indeterminate creates** stay open until an operator settles them (Slice 1). Personal OS publishes no read that answers whether a given key's task exists, so the ledger has no reconciler for them.

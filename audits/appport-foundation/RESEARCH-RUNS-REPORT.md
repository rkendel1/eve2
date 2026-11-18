# Delegated Personal OS research runs, within a person-set budget

This is Slice 3 of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

**Result.** With separate grants for each, eve can start, list, read, cancel and retry a person's research in Personal OS. Every agent-started run works within a **budget the person sets for that agent**: a number of billable calls (model generations and web searches).

**The budget:**

- **Reserved atomically** from the person's budget when the run starts.
- **Charged one call at a time,** _before_ each call is made.
- **Enforced:** no call is made past the run's allocation, after cancellation, or after the person revokes the grant.
- **Fail closed:** a grant without a budget starts nothing.
- **Only the person sets it.** No grant reaches it, and Personal OS refuses any change made under an agent's delegation.

Personal OS's research pipeline does all the work: discovery, plan, search, page reading through `_pages.ts`, assessment and citations. eve has no research tool, logic or state.

## Repositories

| Repository  | Revision                                                                                                 | Note                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal OS | `claude/dreamy-galileo-4z03p5` (`ea356d4`), fast-forwarded to `main` `1cc2145` (Slice 2c merged, PR #28) | This slice                                                                                                                                                                                      |
| FeltKit     | `main` `d68219c`                                                                                         | **Unchanged.** A FeltKit change was considered and reverted; see "No FeltKit change" below. Delegated `/appport` is still in no published release (npm `latest` is 0.3.31, `pending` is 0.3.32) |
| eve2        | `claude/dreamy-galileo-4z03p5` from `e9d3955`                                                            | Tests and docs only                                                                                                                                                                             |

## The existing research architecture (inspected before changing; line numbers are of the source before this slice)

| Piece                                    | Where                                 | What it does                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin` (action)                         | `research.ts:64`                      | Discovers the platform's capabilities (`ctx.agent` catalog, action-only), then `researchstate.create` records the run and its first reply and queues the first step                                                                                                                                                                  |
| `step` (action, the job `research.step`) | `research.ts:175`                     | One step per durable job, **as the run's owner**. It reads the run and does one phase: planning, searching, selecting, reading, assessing or finishing. It commits through `researchstate.advance`, which applies only if the run is still `running`, not `cancelRequested`, and has the same `updatedAt`, then queues the next step |
| Billable calls                           | `research.ts` `ask()`, `searchStep`   | At most **one per step**: a model generation (plan, select, assess; model mode only) or one web search through the `websearch` integration. Reading fetches up to 2 public pages per organization through the safe reader `_pages.ts`; that is not a provider call                                                                   |
| Provider choice                          | `searchStep`                          | From the run's **stored discovery**: discovery must be the server's, never a caller's                                                                                                                                                                                                                                                |
| Durable state                            | `researchRuns`                        | Status, phase, queries, candidates, `usage` (generations, tokens, searches, pages, time), `steps` history, blocker                                                                                                                                                                                                                   |
| Citations                                | `researchSources` and `prospects`     | Sources keyed by `runId` and owner, verbatim, with URL, query, provider and time. Each prospect's `facts` cite `sourceId`s (quotes verified verbatim); its assessment is kept apart                                                                                                                                                  |
| `cancel` (mutation)                      | `research.ts:113`                     | `status: cancelled`, `cancelRequested`. `step` refuses to start and `advance` refuses to commit on a cancelled run                                                                                                                                                                                                                   |
| `retry` (action), `resume` (mutation)    | `research.ts:105`, `researchstate.ts` | Re-discovers, then resumes failed steps. **A completed run is refused**                                                                                                                                                                                                                                                              |
| Delegation re-check                      | `research.ts` `delegationDenied`      | Each step re-checks AuthBoundry, but only for runs started by a surface invocation, as Personal OS's own executor                                                                                                                                                                                                                    |

**What prevented delegating it as it was:**

1. **`begin` and `retry` are actions.** FeltKit refuses actions as capabilities: "An action cannot be an AppPort capability: it is not a transaction… Expose a mutation as the capability, and call it from the action." Actions also get no FeltKit idempotency.
2. **There was no budget at all.** `usage` measured calls but nothing bounded them.
3. **`researchstate.create` and `resume` take a caller-supplied `discovery`,** which decides the provider. They can't be exposed.

## Capabilities

| Capability        | Function                       | Kind                 | Contract                                                                                           |
| ----------------- | ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------- |
| `research.start`  | `researchstate:start` (new)    | mutation, idempotent | `{ text, budget? }` → `{ runId, conversationId, status, budget }`. **An agent must name `budget`** |
| `research.list`   | `research:list`                | query                | The owner's runs, with `budget` and `cancelledBy`                                                  |
| `research.get`    | `research:get`                 | query                | `{ runId }` → `{ run, sources, prospects }` of **that run only**, after an owner check             |
| `research.cancel` | `research:cancel`              | mutation, idempotent | `{ runId }` → `{ status, … }`; repeating it changes nothing                                        |
| `research.retry`  | `researchstate:retryRun` (new) | mutation, idempotent | `{ runId, budget? }`: resume a stopped run, adding `budget` calls; never a completed run           |

**How `research.start` works.** It records the run in a new first phase, `discovering`, and queues the step. The step, an action running as the owner, discovers the platform's capabilities as `begin` does. A new `researchstate.prepare` then plans with the same rules and helpers as `create`. The person's own `begin` and `retry` actions are unchanged.

**Not delegable:**

- `begin` and `retry` (actions);
- `create`, `resume`, `prepare`, `advance`, `charge` and `step` (internal);
- the budget functions.

`delegation.set` refuses to grant any of them.

**Ownership:**

- `research.get`, `cancel` and `retry` use `ops.own`, so another person's run is `NOT_FOUND`.
- `start` records the run for the verified person.
- `list` is owner-scoped.

## Budget

**What it measures: billable calls.** A call is one model generation or one web-search provider call. It is not dollars: provider cost is not reliably reported (`usage.costUsd` appears only when a model reports it). So the budget is a hard, conservative limit on calls.

**What it does not measure:**

- page reads (plain HTTPS fetches through `_pages.ts`, at most 2 per organization, bounded by the pipeline);
- tokens per call;
- time.

**Representation:**

| Record                                           | Fields                                                                                              | Who changes it                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `researchBudgets`, one per person and agent      | `calls` (the person's limit) and `reserved` (held by running runs, plus what finished runs charged) | `calls`: **only the person** (`delegation.setResearchBudget`, refused under any delegation). `reserved`: start, retry and release |
| `researchRuns.budget`                            | `agent`, `allocation` (calls reserved for this run), `charged`, `released`                          | start, charge, release, retry                                                                                                     |
| `researchRuns.usage.generations` and `.searches` | Measured calls that completed                                                                       | The existing pipeline                                                                                                             |

**Enforcement points:**

1. **Start** (`research.start`, one transaction):
   - a delegated start without `budget` → `INVALID_INPUT`;
   - no budget record → `FORBIDDEN`;
   - `budget` larger than `calls − reserved` → `FORBIDDEN`;
   - otherwise `reserved += budget`, in the same commit as the run.
2. **Before each billable call** (`researchstate.charge`, from `ask()` and `searchStep`). It is refused if the run is not `running`, is `cancelRequested`, or has moved on (`updatedAt`). If `charged == allocation`, the run becomes `blocked` with the blocker "research budget", and the call is **not made**.
3. **Each step re-checks the grant.** For agent-started runs, `agentDenied` asks AuthBoundry, as that agent, whether the person still grants it `research.start`. If not, the run is `blocked` (`needs-authorization`) before any call.
4. **Release.** On `completed`, `partial`, `failed` or `cancelled`, `reserved −= allocation − charged`, once. A `blocked` run keeps its reservation so it can resume.
5. **Retry.** It re-reserves a released remainder and any added `budget` from `calls − reserved`. It is refused if nothing is left.

**Concurrency.** The budget record is read and updated inside the start transaction; FeltKit commits with `ifVersion` and fenced reads. Of four simultaneous starts, only those that fit were reserved.

**Charged versus measured.** `charged` counts calls _authorized_, including one in flight when a run is cancelled. `usage` counts calls whose step committed. `charged ≥ measured` always.

## Cancellation

- **Who.** Only the owner, or an agent with `research.cancel` for that owner (owner check plus delegation).
- **What it does.** `status: cancelled`, `cancelRequested`, `cancelledBy` (`owner` or the agent), the unused allocation released, and a `research.cancel` action recorded.
- **It is an execution control.** The next step does not start (`step` guard). No new call is charged (`charge` refuses). The step in flight cannot commit (`advance` refuses, and `cancel` changed `updatedAt`).
- **In flight.** A search already sent **finishes**: the provider cannot be told to stop. Its result is discarded and it stays charged. Nothing claims the provider call was cancelled.
- **After a restart.** The queued job finds the run cancelled and does nothing. No recovery path resumes it.
- **Resuming.** An agent may resume a run it cancelled. **It may never resume a run the owner cancelled** (`cancelledBy: "owner"`), nor a run it did not start. A run stopped before discovery resumes from discovery (a crash found by mutation testing, fixed).

## Idempotency, retry and recovery

- **Start, retry and cancel are mutations** with FeltKit's durable idempotency. The same key replays the same run; a different key is a new run.
- **A completed run** is never run again: `resume` refuses it, and `research.retry` returns `feltkit.FAILED_PRECONDITION`.
- **eve crash after the commit.** eve and Personal OS are both killed after the run is recorded. The retry uses the same key, FeltKit replays it, and there is **one run**.
- **Deferred finding (from Slice 2c), seen again here.** eve's ledger keeps `feltkit.FAILED_PRECONDITION` (for example, a retry of a completed run) as `indeterminate` rather than `failed`. It is safe and never re-sent, but needs operator settlement.
- **No exactly-once external execution is claimed.** A step's job retried after a crash may repeat its provider call. It is charged again before the call, so the budget still bounds it, but the provider may have been called twice.

## Provenance and joins

| Join                                | Evidence                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| eve → FeltKit                       | eve `operation.request_ids[0]` equals the FeltKit audit `requestId` of `researchstate:start` (asserted)                                  |
| FeltKit → AuthBoundry → Personal OS | Audit `authority.delegation.decisionId` equals the Personal OS action `research.start` `delegation.decisionId`; the delegation ids match |
| Personal OS action → run            | Action `evidence.id` equals `runId`; `research.cancel` and `research.retry` actions carry `runId`                                        |
| Run → budget and citations          | `run.budget.agent`; `researchSources.runId`; `prospects.runId`; facts → `sourceId`                                                       |

## Test evidence

**Real:** Personal OS's code and pipeline, FeltKit HTTP `/appport` and durable jobs, the `@authboundry/local` server, and FeltDB.

**Stand-ins:**

- **Search provider:** a local HTTP server with the Brave Search API's shape, owned by the test, which counts every request.
- **Page reader:** Personal OS's own `PAGE_READER` seam.
- **No model:** research plans by its rules, so its only billable calls are searches.

Personal OS `tests/agent-research-real.test.ts`, the 24 requested cases:

| #          | Case                                                      | Observed                                                                                                                                                                       |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 22         | Direct research unchanged                                 | Ada's own `begin`: completed, no budget                                                                                                                                        |
| 3, 5       | No grant; no budget; no `budget` named; more than allowed | `FORBIDDEN`, `FORBIDDEN`, `INVALID_INPUT`, `FORBIDDEN`. Each: no run, **no search**, budget untouched                                                                          |
| —          | Agent raising its budget                                  | `delegation.setresearchbudget` is not a capability; it cannot be granted; called directly with a delegation context → `FORBIDDEN`                                              |
| 1, 2       | Start                                                     | Recorded in Personal OS: `budget {agent: agent:eve, allocation: 2, charged: 0}`; Ada's budget `reserved 2, left 8`                                                             |
| —          | Same key                                                  | The same run                                                                                                                                                                   |
| 7          | Exhaustion                                                | **Exactly 2 searches**, then `blocked` "research budget"; `charged 2 = usage.searches 2`                                                                                       |
| 8, 10, 11  | Read                                                      | Sources all `runId` and owner `ada`; Grace's run → `NOT_FOUND`; not in Ada's list; facts cite this run's sources                                                               |
| 19, 20     | Retry                                                     | Adding 9 calls (more than left) → refused, no search; adding the full plan → completed; `charged == searches ≤ allocation`; unused calls released (`reserved == charged`)      |
| 17, 18     | Completed                                                 | Read twice, unchanged; retry ×2 → `feltkit.FAILED_PRECONDITION`, **no search**                                                                                                 |
| 6          | Concurrent                                                | 4 simultaneous starts of 2 calls: only those that fit reserved; `left` decreased by exactly that; all given back on cancel                                                     |
| 12, 13, 16 | Cancel mid-search                                         | Cancelled _during_ a search: **1 search, none after**; `charged 1`, released, `cancelledBy: agent:eve`, usage 0 (result discarded); repeated cancel unchanged; action recorded |
| 9, 14      | Restart                                                   | After runtime and server restart: still `cancelled`, **no search**                                                                                                             |
| 15         | Resume rules                                              | An agent cannot resume Ada's cancel, nor Ada's own run. Ada can, even before discovery                                                                                         |
| 4, 20      | Revocation                                                | Grant revoked while a run is queued: **no search**, `blocked` `needs-authorization`; retry and start → `FORBIDDEN`                                                             |
| 23         | Provenance                                                | Action `research.start` via `agent` with the delegation; audit `researchstate:start`, person `ada`, linked by decision id                                                      |

eve end to end (`examples/appport-agent/test/personalos.test.mjs`, the research `describe`):

- **eve:** real `eve start`.
- **Personal OS:** a real server process with its private AuthBoundry and its job worker running.
- **Stand-ins:** the test-owned search provider, and pages through the seam.

| Case                                                       | Observed                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No grant; grant without a budget                           | `FORBIDDEN` each; **no search**                                                                                                                                                                |
| Start with budget 2                                        | Run in Ada's Personal OS stops `blocked` "research budget"; **exactly 2 searches**; action and audit joined to eve's request id                                                                |
| Read, retry +4, retry again                                | `research.get` completed; run completed with `charged == searches`; citations are the run's own; the second retry → `feltkit.FAILED_PRECONDITION` (left `indeterminate` by eve), **no search** |
| Cancel mid-search (the search held open while eve cancels) | `cancelled` by `agent:appport-agent`, `charged 1`, released; **only the search in flight**; repeated cancel fine; after a Personal OS restart still cancelled, **no search**                   |
| 21: eve and Personal OS killed after the start committed   | Attempt 2, same key, replayed; **one run**                                                                                                                                                     |
| Revocation                                                 | `FORBIDDEN`                                                                                                                                                                                    |
| 24: leaks                                                  | After the suites: **0** AuthBoundry servers and no Personal OS or eve processes left                                                                                                           |

**Mutation checks** on the Personal OS research test. Each was applied, run and restored. **All were caught**:

| Mutation                                                                                        | Caught by                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| Person ownership removed from `research.get`                                                    | Reading Grace's run                  |
| An ordinary grant implies an unlimited budget (no budget record → allowed)                      | "no budget set" started a run        |
| No charge before a search                                                                       | "exactly the two calls it was given" |
| Concurrent overspend (reservation checks the limit, not what is left)                           | "more than is left" retry allowed    |
| Cancel updates state but does not stop execution (guards removed **and** `updatedAt` unchanged) | "none started after the cancel"      |
| Recovery or the agent resumes the owner's cancellation                                          | "Ada stopped it" allowed             |
| Retry runs a completed run again                                                                | Completed retry no longer refused    |
| `research.get` returns other runs' citations                                                    | "every source is this run's"         |

**A note on the cancel mutation.** A first version removed only the status and cancel checks, and **survived**. `cancel` also changes `updatedAt`, and every step commits only when `updatedAt` is unchanged, so the in-flight step still couldn't commit or queue more. That is a second, independent stop. The mutation that leaves `updatedAt` alone too was caught.

## Test commands and results

| Command                                                                          | Result                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Personal OS `feltkit test tests/agent-research-real.test.ts` (FeltKit main)      | **1 of 1**                                                                   |
| Personal OS existing research, invocation, summon and continuity tests (6 files) | **54 of 54**                                                                 |
| Personal OS `feltkit test` (full suite, FeltKit main)                            | **153 of 153**                                                               |
| Personal OS `feltkit test` on the pinned published FeltKit 0.3.30                | **149 passed, 4 skipped** (the four delegation tests, each saying why)       |
| Personal OS `tsc --noEmit` on FeltKit main and 0.3.30                            | Clean on both. A type-only cast was needed for `decide({ agent })` on 0.3.30 |
| eve2 `PERSONALOS_DIR=… node --test test/personalos.test.mjs`                     | **26 of 26** (tasks 9, memory 5, projects and documents 6, research 6)       |
| eve2 full suite, with `FELTKIT_SDK_DIR` and `PERSONALOS_DIR`                     | **117 of 117** (real-model block skipped: no key)                            |

**Not run:**

- research with a **real model** (planning, selecting and assessing make model calls, each charged by `ask()`; the path was type-checked but not executed with a model);
- the real web (pages came through the seam);
- Personal OS's UI, model and extension e2e scripts.

## Known limitations and deferred findings

- **Calls, not money.** The budget limits calls and doesn't price them. A dollar budget would need reliable per-call cost from providers, which isn't available.
- **Model mode not run.** Model-planned research charges the same way through `ask()`, but no test ran with a model.
- **A cancelled call stays charged.** The provider may still bill for a call that was in flight at cancellation, and the run counts it as charged.
- **Job-retry duplicates.** A step job retried after a crash may repeat a provider call. Each attempt is charged first, so the budget still holds, but the provider was called twice.
- **Deferred (Slice 2c):** eve's ledger classifies `feltkit.FAILED_PRECONDITION` as `indeterminate`.
- **Budget scope.** The budget is per person and agent, not per AuthBoundry delegation id. Revoking and re-granting keeps the same budget; revoking alone stops runs.
- **Lowering a budget.** It stops new starts and additions, but doesn't take back calls already reserved by running runs; the person can cancel those.
- **No Settings screen** for research budgets or agent grants. The functions exist.

### No FeltKit change

FeltKit doesn't carry `ctx.auth.delegation` into an action's nested `runQuery` or `runMutation`. That would matter if a delegated action could run a nested mutation as the person. It can't, because **FeltKit refuses actions as capabilities**. A propagation change was written and then reverted unused. This should be revisited if FeltKit ever allows delegated actions.

**Recorded, roadmap unchanged:** the FeltKit release is pending; reminders need an active session; the AuthBoundry orphan-process behavior is mitigated only in the harnesses; the memory existence oracle; document contents are not readable.

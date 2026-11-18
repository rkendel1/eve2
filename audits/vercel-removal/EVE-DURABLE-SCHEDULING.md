# Durable self-hosted dynamic schedules

## Design

`workflowScheduleProvider()` (`eve/experimental/schedules/workflow`) implements the existing `ScheduleProvider` contract on eve's Workflow world. No new store, timer service, or queue is added.

- **One durable run per schedule version.** Each version is one run of `workflowScheduleWorkflow`, a registered stable framework workflow in `src/runtime/schedules/durable/`. The run:
  - claims a deterministic hook token `eve:schedule:<sha256(namespace, collection, name)>`, whose metadata is the current record;
  - loops: computes the next due occurrence in a step, then races `sleep(next)` against hook messages.
- **Firing.** A step deserializes the agent context captured at creation (`SessionAgentKey`, the connection-events pattern). It then loads the collection definition and calls `dispatchScheduledOccurrence`, the same path as the Vercel queue consumer.
  - `executionId = <scheduleId>:<scheduledAt>` is deterministic, so a retried step delivers the same occurrence, and existing delivery idempotency suppresses duplicates.
- **Changes.** `update`, `enable`, `disable`, and a one-time schedule completing are **handoffs**: the run disposes its hook and starts the next version from a step. The newest live run's hook metadata is always the authoritative record.
  - Callers wait, up to 30 s, until the new version owns the token.
  - `create`, `update`, `enable`, `disable`, and `delete` are idempotent per `operationId`.
- **Reads.** `get` uses `getHookByToken`, accepted only while the owning run is `pending` or `running`, because retained hooks of ended runs are ignored. `list` scans world hooks with the schedule prefix and filters by collection and namespace.
- **Manual invoke.** It dispatches immediately through `context.target.deliver`, the same as the in-memory provider.

## Guarantees and their evidence

| Guarantee                | Mechanism                                                                                                                     | Evidence                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Persists across restart  | The run and hook live in the world (SQLite at `.eve/.workflow-data`)                                                          | Scenario: a disabled schedule is still `inactive` after `SIGKILL` + restart                                     |
| No lost due work         | `sleep` is durable; an overdue timer fires on recovery                                                                        | Scenario: a one-time schedule due during downtime fired **once** after restart, with its original `scheduledAt` |
| No duplicate firing      | Deterministic `executionId`; the run is single-owner by hook claim; step results are recorded                                 | Scenario: a further restart did not fire it again                                                               |
| Missed cron occurrences  | Coalesced into the latest due occurrence, not replayed one by one                                                             | Unit: `nextDueScheduleOccurrence`                                                                               |
| Retry and failure        | The firing step retries per Workflow SDK defaults; a final failure fires `occurrence.failed`, and the loop continues          | Code (`durable/workflow.ts`); not exercised by a scenario                                                       |
| Cancellation and updates | Handoff with dispose before the next version starts                                                                           | Scenario: disable, enable, update, delete                                                                       |
| Tenant isolation         | Namespace and collection partition the token; the collection client authorizes by scope (default `byPrincipal`)               | Scenario: Bob's `list` and `get` cannot see Alice's schedule                                                    |
| Execution history        | Every version and every firing step is recorded in the Workflow world; `occurrence.dispatched` and `occurrence.failed` events | World event log (existing)                                                                                      |
| Timezones                | croner `nextRun` with the expression's timezone; UTC by default                                                               | Unit tests (New York, Berlin, UTC)                                                                              |

Scenario file: `test/scenarios/self-hosted-schedules.scenario.test.ts` (2 tests). It runs on real `eve start` processes, the real local world, and real wall-clock time; a mock model drives the management tool.

## Limits

- `jitter` is accepted but not applied.
- `list` is O(all hooks in the world); this suits hundreds of schedules, not millions.
- **Multi-process.** On the local world, one process (inherited). On the Postgres world, a schedule's hook token can be owned by only one run, so only one process fires it. This is **not tested here**.
- After a code deploy, existing schedule runs resume on the new build. The captured agent context names the agent, not a build.
- Durability across a Workflow world version change follows the world's rules for that change.
- The default for `defineDynamicSchedules` is still `vercelScheduleProvider()`, so users opt in explicitly. Changing the default would alter behavior for existing Vercel users.

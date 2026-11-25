# Eve2 on AppBoundry

## Durable issue-to-PR (in progress, 2026-11-25)

Goal: Eve independently discovers a defect, files it, resolves it, proves the fix and opens a pull request, and
survives provider and host restarts at every stage without losing work or duplicating an external effect.

### Contract: who owns what

| Component | Owns |
|---|---|
| FeltDB (Eve's state) | tasks, executions, evidence, policies, and `blobs`: every file Eve wrote, by SHA-256. A checkpoint is a base commit, path → digest, and the provider's content tree |
| Eve | decisions, policy, proof gates, reconciliation, recovery records (`executions` kind `recover`, `evidence` kind `recovery`) |
| AppBoundry `capabilities@1` | outbound ledger: an attempt is committed before it is sent. A host restart turns an in-flight attempt into `unknown`, never `failed` and never a permanent conflict |
| GitHub provider | disposable. Working copies are rebuilt from base + checkpoint. Issues, comments and pull requests carry an operation marker and are found before being created again. Commits are deterministic. An existing branch is reconciled by tree, never force-pushed. There is no merge capability |

### Recovery rules

| Interruption | What Eve does |
|---|---|
| Working copy gone (provider restarted) | rebuild it from base + checkpointed files. It must come back at the checkpointed tree, or Eve stops |
| Check run lost | run it again. Results are bound to the tree they ran on |
| Issue creation unknown | find the issue by its operation marker. Nothing is sent again until the tracker has answered; a failed lookup keeps the outcome unknown. Sent again (same key) only on an answer that none exists |
| Publish unknown or failed | find the branch and pull request for the operation, again only on an answer. A pull request found is used. Otherwise publishing again reconciles the branch by content |
| Report comment unknown | sent again with the same marker; the provider returns the existing comment |
| Transient failure (`*.UNAVAILABLE`, `TIMEOUT`, `RATE_LIMITED`, unknown) | retry the step with bounded backoff (6 tries), re-reading what it needs |
| Host restarted | in-flight outbound attempts become `unknown`. An operator `tasks:resume` re-queues the task, keeping its identity, and records it |

### Proof gates

- **assess** files a finding only if it has a test Eve wrote and checkpointed, and that test fails on its assertions on
  the unmodified code. A load or setup error does not count. Findings without one are kept as hypotheses.
- **resolve** proposes a change only when:
  - the diff is bounded, within policy, and includes a test;
  - every named test passes on the exact checkpointed tree;
  - every test file the change adds or modifies fails on the base, on its assertions.

  The pull request carries the verified tree and states what was not verified.

### Fault-injection suite: 10/10 on the final code

`test/fault/faults.test.mjs` runs on real processes and real persistence:
- the AppBoundry host, with FeltDB on disk;
- the GitHub provider, killed at a boundary with `FAULT_EXIT_AFTER=<boundary>#<n>` and restarted.

Two stand-ins replace external systems: `github-standin.mjs` for GitHub (REST subset plus a bare git repository) and
`scripted-reasoning.mjs` for the model. Every scenario asserts exactly one issue, one `eve/` branch, one pull request
and one report comment. It also asserts that the published commit is the verified tree, that the new test fails on the
base, that task identity is stable, and that recovery is on record. Result: `evidence/fault-suite/2026-11-25-reconcile.tap`.

| Scenario | Result |
|---|---|
| baseline | pass |
| provider killed after writing the reproduction (assessment) | pass |
| issue created, answer lost | pass (reconciled by marker) |
| provider killed after the fix was checkpointed | pass (rebuilt at the same tree) |
| provider killed as the gate's test run starts | pass |
| branch pushed, provider killed before the pull request | pass (branch reconciled) |
| pull request created, answer lost | pass (found by operation) |
| issue created, answer lost, provider still down at reconcile, lists lagging 20 s | pass (two issues on the old code) |
| pull request created, answer lost, provider still down at reconcile, lists lagging 20 s | pass |
| host killed mid-resolution, resumed twice concurrently | pass |

Limits of the suite:
- GitHub and the model are stand-ins.
- The protections are layered, so removing one mechanism usually still leaves the outcome exactly-once. The suite
  shows the outcome, not each mechanism in isolation.

Defects found on the way, all fixed:
- `NODE_TEST_CONTEXT` leaked into checks and made a failing `node --test` exit 0.
- Providers used a non-protocol error code (`UNAVAILABLE`).
- `git add` failed once `node_modules` existed.
- A host left an outbound attempt `sending` forever after a stop.
- A lost update in Eve's step code.
- Harness faults.

### Live durable runs (real Claude, real GitHub, appboundry `cd32300`)

`run-durable.mjs` runs the workflow on `rkendel1/appboundry`. It kills the provider after the issue is created, after a
fix checkpoint, after the push, and after the pull request. Not yet completed end to end.

| Run | Decisions | Time | Outcome |
|---|---|---|---|
| 1 | 39 | 642 s | no finding. A false negative on a real defect: Eve's test did not truly crash the host |
| 2 | 31 | 280 s | found a real defect (`admin.ts` `#sessions()` reads all sessions unpaged; past 1000 it throws `QUERY_LIMIT_EXCEEDED`). Wrongly rejected: ANSI colour codes hid the failure count from the classifier. Fixed |
| 3 | 36 | 401 s | blocked: the model declined a decision (`reasoning_extraction`). The rationale request was reworded |
| 4 | 41 + 7 | ~500 s | found and proved a real defect, filed as [#101](https://github.com/rkendel1/appboundry/issues/101). **Filed it twice (#102)**: an Eve defect, below. Stopped before publishing |

Run 4, independently verified:
- #101 is real. Eve's reproduction, run on main by hand, fails on its assertion (`expected 'CONFLICT' not to be
  'CONFLICT'`). `TenancyTransaction.commit()` reports an unconfirmed FeltDB commit as a conflict that wrote nothing.
- The duplicate. GitHub created #101; the provider exited before answering (the injected fault). Two things then went wrong:
  - Eve's reconcile lookup reached no provider (`ECONNREFUSED`). Eve read that as "no issue carries the marker" and sent
    the create again.
  - The restarted provider's own marker check used GitHub's issue list. 7 s after #101 was created, the list did not
    include it.

  Both issues carry the same operation marker. The fault suite had missed this: its provider came back before Eve
  reconciled, and its stand-in list never lagged.
- Fixed:
  - Eve sends nothing again after an unknown outcome until a lookup has answered, for issues and for publishing.
  - The provider reads issue numbers above the list's newest, one by one, until one does not exist.
  - The suite gained two scenarios that reproduce run 4: the provider is still down when Eve reconciles, and lists lag
    20 s. On the old code, the issue scenario fails with two issues.
- Stopped early, by my own harness error: the stop condition matched an earlier run's line in the shared log. The run
  ended during implementation, before the checkpoint kill. No branch or pull request was created.
- Assumption: a read of an issue by number reflects a create at once. It is not measured; the list lag is.

## First live result (2026-11-25): issue → PR on a real repository

Eve2, built by FeltKit and running as an `appboundry.app/1` artifact on the AppBoundry host, worked on
`rkendel1/appboundry` through two AppPort providers: Claude (`reasoning.*`) and GitHub (`tracker.*`, `code.*`).

| Step | What happened | Checked independently |
|---|---|---|
| assess | 30 decisions; one finding proposed; its 3 code citations re-read and confirmed by Eve; filed | [#99](https://github.com/rkendel1/appboundry/issues/99) exists. Its claim holds against `main`: a failed effect whose `failed` write is lost is re-run by recovery, against the documented operator-only retry |
| resolve | 23 decisions; 2 files (+73 −6); Eve re-ran 3 test files; pushed `eve/issue-99-dce978aa`; opened the PR; read it back; commented on #99 | [#100](https://github.com/rkendel1/appboundry/pull/100) is open and not merged. The 3 new tests fail with `transactions.ts` reverted to `main` and pass with the fix. The full host suite passes on the branch (127 passed, 15 skipped) |
| CI | the PR's "published, pinned runtime" check fails on a 1.12.0/1.13.0 pin mismatch already in the gap register (X1). `main`'s `CI` and `cloud-portal` have failed on every run since at least Nov 18 | the failures predate Eve's change |

Cost of the passing resolve run: 24 Claude calls (`claude-opus-5-5`), 303 s end to end, 62 capability invocations. Tokens: 39k uncached input, 23k cache writes, 309k cache reads, 23k output (about $0.85 at Opus 5.5 rates).

It took eight runs. Every failure stopped honestly (`blocked`, with the reason on record, and on the issue when
there was one), and every one was a defect in the stack rather than in the model:

| Run | Stopped at | Cause | Fixed in |
|---|---|---|---|
| 1–3 | received | Eve's roles lacked `jobs.create`, then `jobs.execute`. FeltKit's reference host does not authorize jobs, so the isolated tests could not catch it. A job denied at execute is logged only in the host's job audit | Eve2 roles |
| 3 | preparing | the host sent an AppPort idempotency key to read capabilities, which AppPort refuses | AppBoundry `capabilities@1` |
| 4 | investigating | 30 decisions on one hypothesis the model could not settle: dependencies were not searchable, and the budget was not stated | Eve2 (budget), provider (dependency search) |
| 5 | publishing | a lost update in Eve's own step code erased the saved diff | Eve2 |
| 6 | publishing | the providers declared idempotency `required`, which is not an AppPort value | providers, host check |
| 7 | publishing | this environment's proxy refuses GitHub Git Data API writes | provider publishes by `git push`, PR by API |
| 8 | completed | | |

Open limits:
- Code-quote evidence proves the citation, not the behavior. A behavioral finding should carry a failing check.
- Eve checks that its tests pass after the change, not that they fail before it. The PR's own claim was checked by
  hand.
- Working copies live in the provider's memory, so a provider restart loses them.
- The host serves one application per process.
- GitHub sees `rkendel1`, not Eve2.

An experiment: can an agent application be built with the real product stack (FeltKit), run as an AppBoundry
artifact on the shared runtime with no companion process and no credentials of its own, and do consequential work
across real systems through AppPort?

| Layer | What is here |
|---|---|
| FeltKit | `eve2/`: the integration operator, a FeltKit application built with `feltkit build --target appboundry` |
| AppBoundry | `appboundry run eve2.app --capabilities <bindings>`: the host binds each requirement to a provider and holds the credentials |
| AppPort | `providers/`: Slack (`conversation.*`), QuickBooks Online (`finance.*`), Claude (`reasoning.interpret`), each its own process |
| Gate | `gate-capability-bridge/`: the producer-to-host proof this builds on (PASS) |

## Eve2

Eve2 takes responsibility for a request in a source system and carries it into a destination system:

1. It reads the request.
2. It interprets it with a reasoning capability.
3. It checks its authority: a policy, an amount limit, and an approval that exists in the source.
4. It discovers and resolves the destination's records and rules out duplicates.
5. It records the document.
6. It reads the document back and verifies it.
7. It reports where the request was made.

If anything is missing it asks, keeps the task, and resumes when the source changes.

Its durable state is the operation itself, not a transcript:

| Collection | Holds |
|---|---|
| `tasks` | the request, its source, status, open question, intent, plan and target |
| `executions` | every step: what was observed, decided and invoked, with idempotency keys, outcomes and outbound ids |
| `evidence` | source records, approvals, target records, verification results, model usage, detected changes and duplicates |
| `policies` | what Eve may do per operation: approval reaction and approvers, amount limit, currency, retry rule |

It is integration-agnostic: it requires generic contracts (`conversation.messages.get/reply`, `reasoning.interpret`,
`finance.parties.find`, `finance.accounts.find`, `finance.documents.find/create/get`). Slack and QuickBooks are the
first bindings. Gmail or another ledger would be another provider of the same contracts, with no change to Eve2.

## Status (2026-11-25)

| | Result |
|---|---|
| Built by FeltKit, valid `appboundry.app/1`, imports nothing, `network: none`, no components | yes |
| Operating model, isolated (`eve2/test/operator.test.mjs`: the artifact in FeltKit's reference host, systems replaced by in-memory stand-ins) | 10/10. Happy path, ambiguous request, missing approval, timeout after effect, duplicate delivery, change mid-task, capability unavailable, failed verification, authority limit, existing duplicate |
| Claude through AppPort (`providers/reasoning.mjs`, `claude-opus-5-5`, structured outputs, refusal fallbacks) | real calls; ~900 input and 160–240 output tokens, 2.5–3.7 s each |
| Slack provider (`providers/slack.mjs`) | written against the Web API; **not run**: no bot token yet (`auth.test` answers `invalid_auth`) |
| QuickBooks provider (`providers/quickbooks.mjs`) | written against the QBO v3 API (sandbox); **not run**: no Intuit app or sandbox company connected yet |
| End-to-end on real systems | **not yet**. Needs the Slack and QuickBooks access below |

Finding from the first real model calls: asked to list what was unclear, Claude also listed optional details (the
invoice number, the date) and asked who approved. That would have stalled every request on a needless question.
The instruction now limits `unclear` to what prevents a correct entry. Approval is never asked of the model: Eve
checks it from the source.

## What the real run needs

- **Slack:** a workspace and a channel (for example `#eve-finance`) with a bot that is a member, scopes
  `channels:history`, `chat:write` and `reactions:read`. The bot token goes in the environment's network secrets for
  `slack.com`. Set `SLACK_CHANNEL_ID`, and `EVE_APPROVERS` to the approvers' Slack user ids.
- **QuickBooks Online:** an Intuit developer app with a sandbox company.
  - The client id and secret go in a network secret for `oauth.platform.intuit.com` (Basic).
  - A refresh token and realm id from the OAuth Playground go in `QBO_REFRESH_TOKEN` and `QBO_REALM_ID`. The provider
    then keeps the rotated refresh token in its own file.
  - The sandbox needs a vendor (for example "Acme Hosting") and an expense account for hosting.
- **Claude:** `BENCH_API_KEY`.

Then:

```bash
node run-experiment.mjs
```

```bash
node run-experiment.mjs --status
```

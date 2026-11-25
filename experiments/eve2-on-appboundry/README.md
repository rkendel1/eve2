# Eve2 on AppBoundry

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

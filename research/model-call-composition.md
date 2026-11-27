---
issue: "none: context management slice 1 (context composition accounting)"
status: implemented
last_updated: "2026-11-27"
---

# Model call composition accounting

eve records durable facts for every model attempt, but not what each attempt sent. Context cost was argued from synthetic estimates. This slice records the composition of every provider call and joins it to the usage the provider reported. It changes no request, context policy, compaction, or caching.

## Where the request is measured

`model.started` is committed before the request exists. Between it and the provider, eve:

- hydrates sandbox attachments and moves tool-result files;
- frames instructions and retry notes;
- adds cache markers and provider options in `prepareStep`;
- lets the AI SDK convert the result to its provider-neutral prompt.

Moving `model.started` later would change the facts recorded when one of those steps fails. The checker requires `model.retried` to follow its attempt's `model.started`.

The composition is therefore measured in a language-model middleware's `transformParams`, the innermost wrapper before the provider adapter. It is recorded as its own fact:

```
model.started(attempt) → [hydrate, frame, prepareStep, SDK conversion] → transformParams → model.composed(attempt, send) → provider adapter
```

`send` counts the AI SDK's own retries of one attempt. They resend the same request without a new eve attempt, so they were invisible before.

## Semantics

- Token counts come from eve's estimator (`eve-bytes-4`); they are not provider tokenizer counts. `total = system + tools + history`. `toolOutputs` and `summaries` are breakdowns of `history`.
- A compaction summary is recognized by the checkpoint marker at the head of the history. A quoted marker elsewhere is not one.
- `prefixHash` covers tool definitions and system instructions; `requestHash` adds message content. Both exclude headers, provider options (including cache markers), and provider tool arguments, so no credential reaches the record.
- `usage.recorded` keeps recording an unreported count as 0, for existing totals, and lists it in `unreported`.
- `modelCalls(events)` joins attempts and usage by `runId` in stream order. `readShare` is calculated only when cache reads and input were both reported and are consistent with input that includes cached tokens.

## Not measured

- The provider adapter's own serialization: provider-specific wrapping and tool encoding.
- Compaction summary runs, which call the model outside the step's model caller.
- A provider's implicit caching when the request asks for none: `requested: false` does not rule it out.

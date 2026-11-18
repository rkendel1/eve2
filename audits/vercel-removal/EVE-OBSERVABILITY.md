# Provider-neutral observability

## Finding

**Agent Runs is not required.** eve's tracing is OpenTelemetry. Authored `agent/instrumentation/*.ts` files declare:

- `otel()` for process settings;
- `otelIntegration({ traceExporter | spanProcessors, exportPolicy })` for each destination.

Two bundled libraries are involved, and neither contacts a Vercel service on this path:

- `@vercel/agent-runs` defines the span model and ID generator;
- `@vercel/otel` `registerOTel` registers only the processors eve declares.

Agent Runs is one optional destination, seeded only on Vercel preview and production. It reports through the in-process Vercel request context and does nothing elsewhere.

## Span model (existing)

`invoke_agent <agent>` → `agent.step` → `chat <model>` / `execute_tool <tool>` → `agent.approval` / `decision <model>`.

A remote child, such as a workspace peer, starts its own trace linked to the dispatch with `eve.link.type=agent.dispatch`. Correlation attributes include:

- `gen_ai.conversation.id`
- `eve.session.id`
- `eve.turn.id`
- `agent.run.id`
- `agent.schedule.id`
- `eve.environment`

Content (`gen_ai.input.messages`, tool arguments and results) is recorded only for a public audience or in development, unless `tracePolicy` allows it. Each destination can only narrow further with `exportPolicy`.

## Coverage of the requested levels

| Level                         | Span or attribute                                          | Status                                |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Agent, session, turn          | `invoke_agent`, `eve.session.id`, `eve.turn.id`            | Existing                              |
| Tool invocation               | `execute_tool <tool>`                                      | Existing; asserted in the scenario    |
| Delegation                    | Linked trace, `eve.link.type=agent.dispatch`               | Existing; asserted across processes   |
| Approval                      | `agent.approval`                                           | Existing                              |
| Schedule execution            | `agent.schedule.id` on the started session                 | Existing attribute; no dedicated span |
| Workspace and application     | `service.name` from the OTel resource; `gen_ai.agent.name` | Existing                              |
| Artifact creation, deployment | None                                                       | No such eve operations exist to trace |

## What changed

- **Evidence.** `self-hosted-workspace.scenario.test.ts` → "exports nested and linked traces through OpenTelemetry without Vercel":
  - each member has an authored `otelIntegration` whose `SpanExporter` writes real exported spans to a file;
  - Vercel variables are stripped.

  Assertions:
  - `execute_tool research` descends from the coordinator's `invoke_agent` within one trace;
  - the research agent's `invoke_agent` is in a **different** trace that links back to the coordinator's trace with `eve.link.type=agent.dispatch`;
  - no prompt text appears in exported spans under the default policy.

- **Docs.** `docs/guides/instrumentation/otel.mdx` now shows the standard `@opentelemetry/exporter-trace-otlp-http` exporter for any collector, with `@vercel/otel` as an equivalent alternative.

## Traces versus authoritative history

Traces are diagnostic: batched, droppable, and redacted by default. Authoritative execution history stays in the Workflow world, which holds runs, steps, events, delivery records, schedule versions, and delegation callbacks. Nothing in eve reads traces to decide behavior.

## Remaining

- `eve traces` and local traces work only under `eve dev`. A self-hosted operator uses an OTel backend.
- There is no dedicated span for schedule firing.
- Disabling: export nothing (no instrumentation file), `disableInstrumentation`, or `EVE_TRACES=off` for local traces.

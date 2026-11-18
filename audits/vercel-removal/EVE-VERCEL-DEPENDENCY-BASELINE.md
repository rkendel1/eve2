# Vercel architectural dependencies: baseline

Recorded 2026-11-17/18 at the start of this slice. Branch `claude/dreamy-galileo-4z03p5`, HEAD `05f2c46` (clean, equal to the remote; `origin/main` had no new commits). `eve` 1.0.2; CI Node 26.13.1 (`.nvmrc`), engines `>=24`. Evidence came from source reading and executable tests. The previous slices' reports (`audits/vercel-decoupling/`, `audits/self-hosted-parity/`) are not repeated.

Dependency kinds: **B** build time, **R** runtime, **P** persistence, **I** identity, **O** orchestration.

## 1. Multi-agent workspaces build only as a Vercel deployment

- **Path.** `cli/commands/build.ts` → `internal/vercel/build-agent-workspace.ts`. The build writes `.vercel/output/config.json` with Build Output API v3 `services`:
  - per-agent `buildCommand`;
  - `routePrefix: /eve/<name>`;
  - `request.path` transforms rewriting `/eve/<name>/v1/*` → `/eve/v1/*`.
- **Who builds the agents.** Vercel runs each service build. eve itself built no agent.
- **Kind.** B and O. The Vercel platform owned building and routing several agents.
- **Self-hosted before.** Each member was built and started by hand (`cd agents/x && eve build && eve start`). `eve start` at the root required `--agent` and ran one agent.
- **Reusable contracts.** `buildApplication` (member Node builds) and `startProductionServer` (`eve start` child process).

## 2. Agent-to-agent calls need Vercel

- **Default transport.** `public/definitions/workspace-agent.ts`: the default `defineWorkspaceAgent` transport threw unless `VERCEL` was set.
  - URL: `VERCEL_URL` or `VERCEL_PROJECT_PRODUCTION_URL`.
  - Auth: `vercelOidc()`.
- **Callbacks.** Remote delegation is asynchronous: the callee calls back to the caller.
  - `channel/session-callback.ts` and `execution/session-callback-request.ts` refuse loopback and private callback hosts outside `eve dev`.
  - There was no configuration to relax this.
- **Kind.** I and O. No provider-neutral peer identity existed, and same-host callbacks were impossible.
- **Build-time defect.** `runtime/resolve-agent-graph.ts` resolved every remote agent's `url()` during sandbox prewarm. A runtime-only URL therefore failed `eve build` (verified: the build exited with the transport error).
- **Reusable contracts.**
  - `defineRemoteAgent` (callbacks, cancellation, operation ids);
  - `jwtHmac` verification;
  - `forwardPrincipal` + `trustedForwarders`, opt-in on both sides and enforced by the callee.

## 3. Dynamic schedules have no self-hosted provider

- **Default.** `public/schedules/subscription.ts:505` defaults to `vercelScheduleProvider()`, which throws off Vercel. The only alternative was `inMemoryScheduleProvider()`, which has no clock and does not persist.
- **How Vercel fires.** Vercel Schedules → Vercel Queues → `internal/nitro/routes/schedule-collection-consumer.ts` → `dispatchScheduledOccurrence`.
- **Kind.** P and O.
- **Reusable contracts.**
  - the `ScheduleProvider` contract;
  - the Workflow world (`sleep`, hooks, runs);
  - the `connectionEventWorkflow` durable-loop pattern;
  - `dispatchScheduledOccurrence`.
- **`target.deliver` is not usable for durable firing.** It only works inside a live eve request context.

## 4. Deployed self-modification needs Vercel

- **What it does.** It never deploys or activates anything. It checks out a GitHub repository in a sandbox, lets a subagent edit, and opens a **draft pull request** through the GitHub REST API (`self-modification/remote/**`, `github-publisher.ts`).
- **Vercel's only role.** `deployed-sandbox.ts:35` requires Vercel Sandbox. Only its network policy can inject the GitHub token through a header transform, so the token never enters the sandbox. The Docker provider rejects domain-level and transform policies.
- **Kind.** I (credential brokering) and R.
- **No activation or rollback** contract exists anywhere in eve.

## 5. Observability

- **Already provider-neutral.** OpenTelemetry export works without any Vercel service:
  - `otel()` / `otelIntegration()`;
  - the span model from the bundled `@vercel/agent-runs` library;
  - registration through the bundled `@vercel/otel` `registerOTel`, with only eve-declared processors.
- **Vercel-specific parts.** Agent Runs (`agentRuns()`) reports through the in-process Vercel request context and is seeded only when `VERCEL_ENV` is preview or production.
- **Gaps found.**
  - No test proved spans leave a self-hosted server.
  - The docs pointed users to `@vercel/otel` for exporters.
- **Kind.** None mandatory. These are library dependencies, not service dependencies.

## 6. Model metadata needs Vercel at build time

- **Fetch.** `compiler/model-catalog.ts` fetches `https://ai-gateway.vercel.sh/v1/models/catalog` on each build (5-minute cache) for context windows only.
- **Failure without network access or cache.** Static gateway models and direct `anthropic()`/`openai()` models **failed to compile** with `Failed to load AI Gateway model metadata…`, unless `modelContextWindowTokens` was set. Earlier slices succeeded only because this container could reach the gateway.
- **Kind.** B.
- **Reusable.** The catalog schema and the loader's cache path.

## 7. Sandbox templates must be built on the runtime's Docker daemon

- **Runtime reads.** The prepared-artifact manifest is inlined into the server bundle (`compiled-artifacts-data.json` → Nitro text data). The runtime never reads a manifest written after the build.
- **Template contents.** They come from `docker commit` of a container that ran base setup, workspace seeding, and the author's `prepare`. The image _name_ is deterministic across machines (`docker-templates.ts`, `prewarm.ts:323-341`); the contents are not.
- **Production behavior.** Production never prepares templates lazily: `hosted-graph-plugin.ts` replaces the development preparer with a no-op.
- **Kind.** B and R.

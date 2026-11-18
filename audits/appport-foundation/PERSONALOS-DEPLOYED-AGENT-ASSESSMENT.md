# PersonalOS + eve as a deployed agent: capability assessment

Research only. Nothing was implemented, versioned, deployed or published for this report.
`research/runtime-dependency-resolution.md` remains **proposed**, and its implementation remains unapproved.

**The question this answers:** what can PersonalOS do as a real, continuously operating, delegated agent on the platform already built, and what exactly is missing, in which layer?

## 0. Verdict

- **Deployment readiness: not yet.** One product decision (§10 Q1) and three deployment blockers (G1–G3) stand in the way.
- **Already real, and should not be rebuilt:**
  - PersonalOS is a working, model-optional assistant with durable records, an approval gate for model-proposed writes, owner-scoped data, background jobs and an auditable action log.
  - eve, through the PersonalOS agent in `eve2/examples/appport-agent`, executes delegated work against PersonalOS with:
    - per-person AuthBoundry grants;
    - exactly-once write semantics (an operation ledger plus FeltKit's durable `/appport` idempotency);
    - a completion gate and stall detection;
    - contract-pinned, Resolver-replaceable dependencies.
- **What is not true today:**
  - "A user enters a request in PersonalOS and it reaches eve" holds only for **Multiplayer and X**. The in-app chat (web, iOS, Chrome) is answered by PersonalOS's own assistant. Whether eve should answer it is a product decision (§10 Q1).
  - The production combination that was asked about (hosted target, plus Managed FeltDB, plus delegation, on Hetzner, alongside eve) has **no documented or tested path** today.
  - Specifically:
    - Managed FeltDB's production deployment runs on **Fly**.
    - Delegation works only with FeltKit's **local** AuthBoundry, on a persistent disk.
    - Boundry's Hetzner hosts are documented as **not** running customer workloads.
- **Smallest supportable deployment (H1, §8):** one host with two processes, PersonalOS and the PersonalOS eve agent, each with a persistent volume. One operator-owned account; Multiplayer and X off unless explicitly wanted.

**Top five gaps to close first:**

| #   | Gap                                                                                                             | Why first                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | G1 Host placement decision (where the two processes run)                                                        | Nothing deploys without it; Boundry's own documents forbid the obvious choice                     |
| 2   | G2 Data plane: Managed FeltDB on Fly versus a FeltDB/volume on the host, and the migration of existing Fly data | The asked-for "Managed FeltDB" keeps a Fly dependency; there is no documented import into managed |
| 3   | G3 Delegation authority: local AuthBoundry needs persistent state; hosted AuthBoundry is refused by FeltKit     | Every eve call to PersonalOS depends on it                                                        |
| 4   | G7 Give the PersonalOS eve agent an owned, versioned home (it is an eve2 _example_)                             | There is nothing proper to deploy until it has one                                                |
| 5   | G13 Background work stops once the person has had no session for 7 days                                         | Blocks "operates for weeks while nobody is connected"                                             |

## 1. Method and evidence base

**Repositories inspected**, with the commit each was read at:

| Repository         | Path                             | Read at                                                  | `origin/main` |
| ------------------ | -------------------------------- | -------------------------------------------------------- | ------------- |
| eve2               | `/home/user/eve2`                | `f8ce3d0` (main)                                         | `f8ce3d0`     |
| PersonalOS         | `/home/user/rkendel1/personalOS` | `7ed8099` (= main content)                               | `e471bde`     |
| FeltKit            | `/home/user/feltkit`             | `be1adff` (branch; **AppBoundry 1.12.0 pin not merged**) | `c3bef54`     |
| FeltDB (`flow_db`) | `/home/user/flow_db`             | `0f5049e`                                                | `0f5049e`     |
| AppBoundry         | `/home/user/appboundry`          | branch `76aebd3`; main read via `git show origin/main:`  | `98a8f11`     |
| AppPort            | `/home/user/appport`             | `a6c2c61`                                                | `a6c2c61`     |
| AuthBoundry        | `/home/user/authboundry`         | `3945f49` (cloned for this report)                       | —             |
| Resolver           | `/home/user/rkendel1/resolver`   | `aaab053` (0.4.1; cloned read-only)                      | —             |

- **Not available as a separate repository:** "Boundry deployment infrastructure". It lives in `appboundry/deploy/` (`boundry`, `staging-host`, `staging-control-plane`, `artifact-runner`) and in `flow_db/deploy/`.
- **Not verifiable from any repository:**
  - what is actually installed on the Hetzner server;
  - whether the AuthBoundry cutover succeeded;
  - whether eve2's GitHub Actions are enabled. The proxy refused `actions/permissions`, and the runs query returned `total_count` 0.

**Tests run today** (recorded, all local):

| Command                                                                                 | Result                                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm test` in PersonalOS on installed `@feltdb/feltkit` 0.3.33                          | **166 passed, 0 skipped**. On 0.3.30 it was 161 passed and 5 skipped. |
| `npm test` in `eve2/examples/appport-agent` with `PERSONALOS_DIR` and `FELTKIT_SDK_DIR` | **160 passed, 0 failed** (node test runner totals)                    |
| FeltKit `npm run test:appboundry` against published `@appport/appboundry` 1.12.0        | 1 passed                                                              |
| FeltKit AppBoundry and self-hosted deploy unit tests                                    | 15 passed; 2 of 2 mutations caught                                    |

No new tests were needed. All further evidence is from source reading and is cited by `repo:path:line`.

**Integration history (merged PRs):**

| Repository | PRs                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eve2       | `rkendel1/eve2#10`–`rkendel1/eve2#21` (slices 1–8, research doc)                                                                                                        |
| PersonalOS | `rkendel1/personalOS#22`–`rkendel1/personalOS#32` (delegation, memory, projects and documents, research, identity linking, AnywhereAide, mainline baseline, 0.3.33 pin) |
| FeltKit    | `rkendel1/feltkit#142` (delegated `/appport`), `rkendel1/feltkit#143` (boundary tests)                                                                                  |

### Claims to verify, with corrections

| Claim given                                                          | Finding                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PersonalOS uses published FeltKit 0.3.33                             | **True.** `personalOS/package.json` at `7ed8099`, merged as `e471bde`.                                                                                                                                                                                                                     |
| PersonalOS 166/166 with delegation suites running                    | **True** today. The four `agent-*-real` suites run; `real-provider` needs a model key and still counts as passing.                                                                                                                                                                         |
| eve example 160/160 against PersonalOS                               | **True** today (runner totals).                                                                                                                                                                                                                                                            |
| Replacement: 13/13 tests, 7/7 mutations                              | **True** as recorded (`CONTRACT-VERIFIED-REPLACEMENT-REPORT.md`; `examples/appport-agent/test/replacement.test.mjs`). Not re-run today.                                                                                                                                                    |
| "Switching without rebuilding or restarting"                         | **True for AppPort dependencies only.** Resolution happens per use (`examples/appport-agent/agent/lib/appport.ts:67-139`).                                                                                                                                                                 |
| Dependency resolution is example-layer only                          | **True.** Nothing of it exists in `packages/eve`: no `defineAppPortDependency`, no `experimental/resolver` export (`research/runtime-dependency-resolution.md:9-11`).                                                                                                                      |
| Model references lack equivalent coverage                            | **Partly stale.** See the model-references row below.                                                                                                                                                                                                                                      |
| Resolver compatibility gaps                                          | **True.** See the Resolver gaps row below.                                                                                                                                                                                                                                                 |
| eve CI historically incomplete                                       | **True, cause unverified.** See the eve CI row below.                                                                                                                                                                                                                                      |
| "Eve runs as the agent runtime alongside the PersonalOS application" | **Not how it is built.** PersonalOS does not start eve. eve is a separate HTTP service that PersonalOS calls through its `agent` integration (`personalOS/feltkit/app.ts:185-231`). FeltKit has no sidecar support: components are same-process only (`feltkit/docs/COMPONENTS.md:16-24`). |
| `npx feltkit deploy --target hosted` deploys PersonalOS              | **It only writes a verified artifact.** FeltKit operates no hosting service (`feltkit/packages/sdk/src/cli/deploy.ts:1-16`). The artifact is a Docker image running `feltkit start` with `FELTKIT_STORAGE=managed` (`deploy.ts:418-437`).                                                  |

**Model references, in detail:**

- PersonalOS's **own assistant** already resolves its model from Resolver: `agent.model.production = "ref://prod/personalos/model"` (`personalOS/feltkit/app.ts:113-116`). FeltKit resolves it at runtime (`feltkit/docs/RESOLVER.md`), and Resolver has a `model` kind (`resolver/server/src/targets.ts:70-91`).
- The **eve agent's** model is static: `anthropic(process.env.APPPORT_AGENT_MODEL ?? "claude-sonnet-5")` (`examples/appport-agent/agent/agent.ts:4-7`). eve-side model references exist only in the proposal.

**Resolver gaps, in detail:**

- A re-pin is checked only against its own digests, with no comparison to the previous binding (`resolver/server/src/targets.ts:100-126`).
- `ReferenceState` is only `active | revoked` (`resolver/core/src/protocol.ts:49`).

**eve CI, in detail:**

- `eve2/.github/workflows/ci.yml:3-8` triggers on push and pull requests with no repository gate, yet no runs are visible.
- The likely cause is that Actions are disabled on the repository. That is a setting, and it is unverifiable from here.
- Even with CI running, the PersonalOS and FeltKit suites would skip: `PERSONALOS_DIR` and `FELTKIT_SDK_DIR` are not set (`ci.yml:276-280`).

## 2. Actual architecture and request path

There are **two** request paths. Only the second involves eve.

```
 Path 1: in-app (web / iOS / Chrome)                Path 2: connected surfaces (Multiplayer, X)
 ───────────────────────────────────                ─────────────────────────────────────────────
 PersonalOS UI ──turn (app.action)──▶ PersonalOS     surface ──bridge/xadapter session──▶ PersonalOS
   FeltKit runtime, one process                         interactions.receive / xsurface
   ├─ deterministic rules (assistant.send)              ├─ Resolver: sender → linked person
   ├─ ctx.model (Resolver model ref) proposes           ├─ AuthBoundry: personalos.assistant.converse
   ├─ ctx.agent.propose → owner approves in UI          └─ anywhere.handOff → job anywhere.follow
   └─ FeltDB (volume today) records + action log              │ POST /work (ES256 identity token,
                                                              ▼  Idempotency-Key = surface event id)
                                                     eve agent (examples/appport-agent, own process)
                                                       ├─ /work channel → eve session (local World)
                                                       ├─ model plans; tools appport_*
                                                       ├─ operation ledger (FeltDB, local dir)
                                                       └─ POST PersonalOS /appport
                                                            Bearer agent session +
                                                            X-AppPort-On-Behalf-Of: person
                                                              ▼
                                                     PersonalOS delegated /appport
                                                       ├─ AuthBoundry (local) decides the grant,
                                                       │  proven as the agent, per capability
                                                       ├─ idempotency replay (durable)
                                                       └─ same handlers, owner-scoped, action log
                                                     ◀── GET /work/{id} polled every 2 s (≤ 24 h)
                                                     reply written to the surface's own record
```

### Path 1: the in-app assistant

| Step                        | Implementation                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI                          | Chat calls `useAction(api.turn.turn)` (`personalOS/src/chat.tsx:92,121`). Other screens call the deterministic `assistant.send` (`src/App.tsx:139-142`).                                                                            |
| Authentication and identity | FeltKit sessions with built-in accounts. Every handler scopes by owner through `_ops.me()` / `own()` (`personalOS/feltkit/_ops.ts:30-45`). The file `_own.ts` cited at `app.ts:9` does not exist (stale comment).                   |
| Turn                        | `turn` is a request-scoped action, **not a job** (`personalOS/feltkit/turn.ts:89`). Rules run first; the model runs only if enabled and ready (`turn.ts:110-112`); otherwise the deterministic path handles it (`turn.ts:129-134`). |
| Model                       | Up to 3 rounds of `ctx.model.generate` (`turn.ts:31,174`). Tool calls go to `ctx.agent.propose`: observations run, consequential actions wait as proposals (`feltkit/packages/sdk/src/runtime/agent.ts:23-25,465,715-724`).         |
| Streaming                   | `ctx.emit` delta and turn events (`turn.ts:140,172`). A disconnect cancels the generation. A streamed reply is not resumed (`personalOS/docs/LIMITATIONS.md:26-27`).                                                                |
| Durable state               | FeltDB, on the Fly volume today: conversations, messages, memory, tasks, projects, documents, research and actions (`personalOS/feltkit/app.ts:416-509`).                                                                           |
| Background                  | The FeltKit worker runs once a second. Jobs re-authorize as their creator on every attempt (`feltkit/docs/GUARANTEES.md`, "Durable work"; `feltkit/packages/sdk/src/runtime/runtime.ts:990-1006`).                                  |

### Path 2: connected surface to eve

| Step                    | Implementation                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound                 | `interactions.receive` (`personalOS/feltkit/interactions.ts:84+`) and `xsurface` (`xsurface.ts:371`). Both resolve the sender through Resolver identity links (`links.ts`).                                                                                                                       |
| Authority               | `ctx.authority.decide({capability: "personalos.assistant.converse"})` before any handoff (`interactions.ts:201-213`).                                                                                                                                                                             |
| Handoff                 | `handOff` → job `anywhere.follow` → integration `agent.submit` `POST /work` with `Idempotency-Key`. A `verify` lookup settles ambiguous submissions (`personalOS/feltkit/app.ts:193-231`; `anywhere.ts:146-206`). The handoff only happens when `PERSONALOS_AGENT_URL` is set (`anywhere.ts:43`). |
| eve entry               | `examples/appport-agent/agent/channels/work.ts:114-231`. It verifies PersonalOS's ES256 identity token (`APPPORT_AGENT_IDENTITY_PUBLIC_KEY` / `_ISSUER`) and runs the work as `<issuer>:<person>` (`work.ts:45-72,148-157`).                                                                      |
| Session                 | An eve session in the **local Workflow world** (`.eve/.workflow-data`). The example sets no `experimental.workflow.world` (`agent/agent.ts`). Work records live in FeltDB at `APPPORT_AGENT_WORK_DIR` (`agent/lib/work.ts:28-31`).                                                                |
| Tools                   | `appport_capabilities`, `appport_contract`, `appport_invoke` (`agent/tools/*`). The principal comes only from `ctx.session.auth.current`, never from the model.                                                                                                                                   |
| AppPort                 | Bearer agent session plus `X-AppPort-On-Behalf-Of` (`agent/lib/appport.ts:387-425`). For mutations the idempotency key is the operation ID (`operations.ts:131-135,228`).                                                                                                                         |
| Authority at PersonalOS | FeltKit `verifyDelegation` requires `executorProof.method === "agent_credential"` from the **local** registry (`feltkit/packages/sdk/src/runtime/runtime.ts:813-846`). Hosted AuthBoundry is refused (`feltkit/docs/LOCAL-AUTHORITY.md:145-146`).                                                 |
| Data                    | The same PersonalOS handlers, owner-scoped, writing action-log rows with `via: "agent"` and delegation ids (`personalOS/feltkit/_ops.ts:62-74`).                                                                                                                                                  |
| Evidence back           | The completion gate needs every operation final, the requester's own, with at least one recorded success that is cited (`agent/lib/work.ts:279-356`). PersonalOS keeps the agent record verbatim (`anywhere.ts:1-27`).                                                                            |

### Boundary observations

- **No bypass found.** eve never writes PersonalOS state directly; every effect goes through `/appport`, AuthBoundry and the handlers. PersonalOS never gives eve Resolver keys or reply addresses (`personalOS/feltkit/anywhere.ts:10-16`).
- **eve session routes check the caller, not session ownership** (`eve2/docs/guides/auth-and-route-protection.md:304,323`; `packages/eve/src/eve-channel/index.ts:675-681`).
  - In the example, only the operator's HS256 secret reaches `/eve/v1/*` (`agent/channels/eve.ts:4-13`), so no person can attach to another person's session today.
  - This becomes a real gap the moment per-user callers get `/eve/v1` (G9).
- **eve decides "production" from `VERCEL_ENV`** (`packages/eve/src/internal/application/dev-environment.ts:28-31`). The example sets explicit authentication, so this is a configuration hazard, not an open route.

## 3. Capability inventory

### A. User interaction

| Capability                  | PersonalOS exposes                                                                                                                                              | eve provides underneath                                                                | Status                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Conversational interface    | Chat with streaming (`src/chat.tsx`)                                                                                                                            | Session API with NDJSON streams (`docs/concepts/sessions-runs-and-streaming.md:38-46`) | **Works** (PersonalOS's own assistant)                                                                                   |
| Persistent conversations    | FeltDB conversations and messages                                                                                                                               | Session event log in the World                                                         | Works                                                                                                                    |
| Multiple tasks and projects | Tasks, projects, research runs                                                                                                                                  | One session per work item                                                              | Works                                                                                                                    |
| Streaming and progress      | Turn deltas. Research shows step state. Agent work shows a status the surface relays.                                                                           | Stream follow and cursor                                                               | Works. A turn's stream is not resumable.                                                                                 |
| Clarifying questions        | The model asks in its reply                                                                                                                                     | `ask_question` / `ctx.ask()` (`docs/tools/human-in-the-loop.md:343-370`)               | PersonalOS: in the reply only. eve: available, **not used** by the agent.                                                |
| Approval                    | Proposal cards; `actions.approve` is `approval: "required"` (`personalOS/feltkit/actions.ts:16-41`; `src/chat.tsx:93-97`)                                       | Tool `approval` policies (`human-in-the-loop.md:14-30`)                                | **Works** for in-app model proposals. The eve path relies on per-capability grants instead of per-action approval (§3H). |
| Cancel and steer            | Abort a turn (`chat.tsx:301`); cancel research (`research.ts:114-131`)                                                                                          | `POST /eve/v1/session/:id/cancel`; new messages interrupt by default                   | Agent work and invocations have **no cancel** (G19)                                                                      |
| Completion notifications    | In-app inbox: reminders, check-ins, weekly review, invocations (`inbox.ts`; `src/screens.tsx:77-95`); webhooks                                                  | —                                                                                      | In-app only. No push or e-mail (G20).                                                                                    |
| Cross-device resume         | Records are in FeltDB, so any device sees them                                                                                                                  | Session ID reattach                                                                    | Works for records. An in-flight stream is lost.                                                                          |
| Execution history           | Activity screen (`src/screens.tsx:429`); "Where this came from" (`chat.tsx:321`); continuity across surfaces (`continuity.ts:96-105`)                           | Event log; OpenTelemetry                                                               | **Works** in PersonalOS                                                                                                  |
| Evidence and provenance     | Action log with read-back `evidence{collection, id, version, verified}` (`_ops.ts:83-88`); model, reference and generation shown per reply (`chat.tsx:225-228`) | Agent ledger plus a checkpoint citing operations (`channels/work.ts:291-314`)          | Works. Model provenance on approved proposals is weak (G12).                                                             |

### B. Durable execution

**Three different things are durable, in three places:**

- **PersonalOS application data:** FeltDB.
- **eve session and workflow state:** the Workflow World, local SQLite under `.eve/`.
- **eve agent work and operation ledger:** a separate local FeltDB under `APPPORT_AGENT_WORK_DIR`.

**Managed FeltDB would cover only the first.** eve has no FeltDB World (no `feltdb` anywhere in `packages/eve/src`). Its supported Worlds are local, Postgres and Vercel (`eve2/docs/guides/deployment/workflow-worlds.md:10-14`).

| Capability                                  | Status and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survives restarts                           | **PersonalOS:** records and jobs, yes. A streamed turn, no. **eve:** sessions resume from the World; completed steps never re-run (`docs/concepts/execution-model-and-durability.mdx:190`).                                                                                                                                                                                                                                                                                                                                              |
| Continues after the user disconnects        | **In-app turn: no.** It is cancelled. **Research, reminders, invocations and agent work: yes**, as jobs and eve sessions.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Multi-step and long-running                 | Research is a job per step (`personalOS/feltkit/research.ts:1-23`). Agent work is an eve session, followed for up to 24 h (`anywhere.ts:40`).                                                                                                                                                                                                                                                                                                                                                                                            |
| Checkpoint and recovery                     | eve: step durability. Agent: ledger states `prepared → executing → succeeded \| failed \| indeterminate` with compare-and-set (`operations.ts:45,143-158`).                                                                                                                                                                                                                                                                                                                                                                              |
| Retry semantics                             | **eve alone is at-least-once:** "Recovery doesn't make external effects exactly-once" (`execution-model-and-durability.mdx:204-208`). The agent closes this with the ledger: a crashed send with an idempotency key is re-sent with the same key; without one it becomes `indeterminate` and is never re-sent (`operations.ts:294-307,367-381`). PersonalOS replays a repeated key from a durable store, including after a restart (`feltkit/packages/sdk/src/runtime/capabilities.ts:39-41`; test `delegated-appport.test.ts:152-161`). |
| Idempotent external actions                 | **Agent to PersonalOS:** exactly-once through the key, so no double write is possible on this path. **PersonalOS to eve:** `/work` keyed by the surface event id, with lookup verification. **PersonalOS to its own integrations** (X, search): keys where declared; `x.reply` has explicit retry states.                                                                                                                                                                                                                                |
| Human-input waits                           | eve: `ctx.ask`, hooks, `sleep` (`docs/tools/workflows.mdx:126-134`). The agent does not use them; it fails to an operator `indeterminate` state instead.                                                                                                                                                                                                                                                                                                                                                                                 |
| Webhook continuation                        | eve: `createWebhook` on `/.well-known/workflow`. Not used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Scheduled execution                         | PersonalOS uses self-rescheduling job chains for check-ins and the weekly review (`checkins.ts:25-27,67-71`; `weekly.ts:31-32`). FeltKit schedules are "not exercised end to end" (`feltkit/docs/GUARANTEES.md`, Schedules row). eve schedules exist (`docs/schedules.mdx`); the agent has none.                                                                                                                                                                                                                                         |
| Task cancellation                           | §3A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Recovery after a deployment or model change | **eve upgrades strand in-flight sessions** on the local and Postgres Worlds (`workflow-worlds.md:10-16`) (G23). Recovery of stalled agent work is **lazy**: it runs on the first `/work` or `GET /work` after boot (`work.ts:102-110`). PersonalOS polls every 2 s while following, which triggers it in practice.                                                                                                                                                                                                                       |

**Where an operation can still execute twice, or end ambiguously:**

- **eve tools without an idempotency key.** The agent turns these into `indeterminate`, then operator settlement (`operations.ts:628-690`).
- **PersonalOS's own `tasks.create`** called twice by a person, or by the deterministic path. It is not deduplicated, because a new row is created per call.
- **Integrations whose provider is not idempotent** (X posting). PersonalOS tracks reply states and does not blindly resend.

### C. Agent tools (what the PersonalOS eve agent can actually invoke)

| Tool                   | Purpose and contract                                                                                                  | Authority                                                                                      | Deterministic?                                                        | Idempotent                          | Durable result        | Evidence                                     | Async                                       | Replaceable without redeploy           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- | --------------------- | -------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| `appport_capabilities` | `{}` → capabilities with effect, idempotency, invocable (`agent/tools/appport_capabilities.ts`; `appport.ts:180-194`) | none (manifest read)                                                                           | yes                                                                   | n/a                                 | no                    | no                                           | no                                          | Yes: the endpoint comes from Resolver  |
| `appport_contract`     | `{name}` → schemas, permissions, effect (`appport.ts:196-210`)                                                        | none                                                                                           | yes                                                                   | n/a                                 | no                    | no                                           | no                                          | Yes                                    |
| `appport_invoke`       | `{name, input, operationKey?}` → `{ok, output\|error, operationId, operationState, …}` (`appport_invoke.ts`)          | the person's AuthBoundry grant per capability, plus the `APPPORT_AGENT_CAPABILITIES` allowlist | the model chooses **what**; the ledger decides **whether** it is sent | **yes**: operation ID → AppPort key | yes: ledger in FeltDB | yes: invocation records, cited at checkpoint | no wait; indeterminate goes to the operator | Yes: Resolver binding, contract-pinned |

**PersonalOS capabilities reachable through `appport_invoke`.** These are the delegable set, `AGENT_CAPABILITIES` (`personalOS/feltkit/_authority.ts:75`):

- `tasks.list/create/update/complete/reopen`
- `briefing.today`
- `memory.list/propose` (an agent can never confirm, update or forget: `_ops.ts:224-230`)
- `projects.list/create/update`
- `documents.list/update`
- `research.start/list/get/cancel/retry`

**Not delegable:**

- `assistant.send`, conversations, `actions.*`;
- `memory.add/confirm/update/remove`;
- deleting tasks (by design: `personalOS/feltkit/app.ts`; backlog §2a).

**Missing tools, judged by delegable work:**

- reading document **contents** (only `documents.list` exists, and `turn.ts:51` never reads contents);
- search across projects, documents and memory;
- any reminder control beyond what task updates imply;
- notifying the person directly (only the surface reply and the PersonalOS conversation exist).

### D. Memory and knowledge

| Layer                          | Where                                                                                                                                                | Notes                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Session context                | PersonalOS turn context (`turnstate.ts:49-70`); eve session history                                                                                  | Per turn or session                         |
| Durable session state          | eve World; `defineState` exists but the agent does not use it                                                                                        | —                                           |
| Application records            | PersonalOS FeltDB                                                                                                                                    | Authoritative                               |
| Preferences                    | `settings` (`personalOS/feltkit/settings.ts`)                                                                                                        | Includes `modelAssist`                      |
| Long-term memory               | `memory` collection: `status` confirmed/inferred, `source{kind: conversation\|manual\|model\|agent, quote, …}` (`personalOS/feltkit/app.ts:416-440`) | Confirm, update, remove (`memory.ts:39-63`) |
| Project and document knowledge | Projects; documents as AppPort Services Files                                                                                                        | Contents not indexed or read                |
| External knowledge             | Research sources with `textKind` and provider; quotes checked verbatim (`research.ts:12-17`; `app.ts:839-864`)                                       | Provenance-preserving                       |
| Derived summaries and indexes  | None. `search:` is declared on collections but `ctx.db.search` is unused                                                                             | G18                                         |
| Agent-generated knowledge      | `memory.propose` → inferred, needs the owner's confirmation                                                                                          | —                                           |

**What the agent can do with memory:**

| Question                        | Answer                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Across sessions                 | **Yes.**                                                                                                                                                                                                                       |
| Recall without being told       | **Yes, by keyword.** The top 25 memories go into model context automatically, inferred ones labelled (`turnstate.ts:59-67`). This is PersonalOS's own assistant only. The eve agent sees memory only by calling `memory.list`. |
| Update with provenance          | **Yes.**                                                                                                                                                                                                                       |
| Correct or retract              | **Yes.** In chat, as a proposal; in the UI, directly.                                                                                                                                                                          |
| Distinguish fact from inference | **Yes** (`status`).                                                                                                                                                                                                            |
| Explain why                     | **Partly.** It has the source quote and conversation, but no reasoning trace.                                                                                                                                                  |
| Search projects and documents   | **No.**                                                                                                                                                                                                                        |
| Isolate users                   | **Yes.** Owner scoping on every handler; service-role scans are limited to the X adapter (`xsurface.ts:451-500`).                                                                                                              |

**One write bypasses confirmation.** An invocation the model classifies as "save" stores a **confirmed** memory (`personalOS/feltkit/invocationstate.ts:180`). It is gated by the person's `personalos.memory.write` grant and holds their own shared content, but the "confirmed" label is decided by intent classification (G25).

### E. Planning and delegation

| Capability                                         | Status                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Multi-step planning                                | eve model loop within one session. PersonalOS research has a fixed deterministic pipeline with model steps checked by rules.                                                   |
| Deterministic workflows                            | PersonalOS rules, jobs and research pipeline; eve `defineWorkflowTool`.                                                                                                        |
| Mixed deterministic and agentic                    | **Yes.** Research is the clearest example. The ledger wraps model-chosen invocations in deterministic gates.                                                                   |
| Subagents and parallel work                        | eve supports subagents with their own models (`docs/subagents/index.mdx`). **Not used** by the agent.                                                                          |
| Dependencies between tasks                         | None. Each work item is independent.                                                                                                                                           |
| Progress and partial results                       | Work status, operations list, report (`anywhere.ts` AgentRecord).                                                                                                              |
| Escalation to the user                             | `blocked`/`indeterminate` states surface to PersonalOS and the operator. eve's `ctx.ask` is not wired into a surface.                                                          |
| Resumption                                         | Yes: durable sessions, lazy recovery.                                                                                                                                          |
| Prioritization                                     | None.                                                                                                                                                                          |
| Continuing assistant, not just prompt and response | **PersonalOS, partly:** reminders, daily check-ins and the weekly review as job chains. **eve: no.** Work exists only when a surface hands it over; there is no standing loop. |

### F. External integrations

| Integration                                                | Connected?                                                                                                                     | Setup                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PersonalOS `/appport` (delegated)                          | **Connected and tested**, with local AuthBoundry                                                                               | Agent session; `delegation.registerAgent`; person's `delegation.set`                                                                            |
| Resolver: identity links, model reference, AppPort binding | Connected                                                                                                                      | `RESOLVER_URL`, keys. Production Resolver is reported at `resolver.boundry.company` (`personalOS/docs/FELTKIT-CHANGES.md:175`), unverified live |
| Web search (`websearch`, `openaisearch`)                   | Available; needs credentials (`personalOS/feltkit/app.ts:239-293`)                                                             | Operator                                                                                                                                        |
| X                                                          | Connected on Fly per docs (`personalOS/docs/X.md:198-215`)                                                                     | OAuth with a rotating grant, so it needs a writable vault                                                                                       |
| Multiplayer bridge                                         | Code and tests; live deployment unverified                                                                                     | Operator-issued bridge session                                                                                                                  |
| eve MCP and OpenAPI connections                            | Framework only (`docs/connections/index.mdx`); unused                                                                          | —                                                                                                                                               |
| User-connected accounts (OAuth per user)                   | Framework only in eve (needs a `principalType: "user"` caller). PersonalOS has none per user                                   | —                                                                                                                                               |
| Webhooks out                                               | PersonalOS emits `task.completed`, `reminder.fired`, `document.added`, `interaction.updated` (`personalOS/feltkit/app.ts:126`) | Operator registers endpoints                                                                                                                    |
| Notifications out                                          | In-app only                                                                                                                    | —                                                                                                                                               |

### G. Model and inference

| Question                                        | PersonalOS (own assistant)                                                                              | eve agent                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Configuration                                   | Resolver reference `ref://prod/personalos/model` (`app.ts:113-116`)                                     | `anthropic(APPPORT_AGENT_MODEL)` (`agent.ts:4-7`)                                  |
| Change without redeploy                         | **Yes** (Resolver; resolution cached 5 minutes)                                                         | **No:** at least a restart; build versus start reading unverified                  |
| Per-task model                                  | No                                                                                                      | eve supports `defineDynamic` and per-subagent models; unused                       |
| Local models                                    | FeltKit Intelligence supports OpenAI- and Anthropic-compatible endpoints (`feltkit/docs/GUARANTEES.md`) | eve supports OpenAI-compatible and local providers (`docs/agent-config.md:87-133`) |
| Fallback                                        | Deterministic assistant only; no second model (`turn.ts:129-134,221-226`)                               | None (`agent-config.md:162`)                                                       |
| Credentials out of durable state                | Yes: FeltKit custody (`GUARANTEES.md`, Secrets)                                                         | Yes: environment                                                                   |
| Model recorded in evidence                      | Yes, per generation, shown in chat (`chat.tsx:225-228`)                                                 | Not in the ledger                                                                  |
| Operation pinned to its resolved implementation | n/a                                                                                                     | **AppPort dependency: yes** (`OperationRecord.implementation`, slice 8). Model: no |

**The Resolver model-reference design**, assessed separately:

- **Implemented in Resolver** (`model` kind) and consumed by FeltKit.
- **Proposed only for eve** (`resolvedModel` in the research document).

### H. Security and authority

| Concern                             | Finding                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User authentication                 | FeltKit sessions and accounts. A production session needs an expiry of at most 90 days (`feltkit/packages/sdk/src/server/admin.ts:1060-1066`); the default is 7 days (`runtime/sessions.ts:51`)                                                                                                              |
| Agent identity                      | The eve agent is a FeltKit agent principal with no permissions of its own (`personalOS/feltkit/app.ts:84-86`), proven by the local AuthBoundry agent credential                                                                                                                                              |
| User-delegated authority            | Per person, per capability, exact allow, decided at every call, revocable (`feltkit/packages/sdk/src/runtime/delegation.ts:67-89`)                                                                                                                                                                           |
| Tool authorization                  | Deterministic at three layers: the agent allowlist, the AuthBoundry grant, and the handler's owner scope. **No model-only authority path found.**                                                                                                                                                            |
| AppPort contracts                   | Pinned per capability digest. A drift is refused before sending (`operations.ts:313-364`)                                                                                                                                                                                                                    |
| Tenant and resource boundaries      | One person per owner. No tenancy, by design (slice 7)                                                                                                                                                                                                                                                        |
| Secret custody                      | FeltKit custody; the eve environment; Resolver vault                                                                                                                                                                                                                                                         |
| Sandbox                             | The agent uses none                                                                                                                                                                                                                                                                                          |
| Network egress                      | PersonalOS page reader guards private addresses (`_pages.ts:1-45`). The agent fetches a Resolver-supplied discovery origin without an SSRF guard (`appport.ts:120`), so it trusts Resolver's outbound policy                                                                                                 |
| Human approval of sensitive actions | **In-app:** every consequential model action is a proposal. **eve:** a grant is standing consent. Irreversible actions (delete) are not delegable at all. **The model can start billable research without approval, and owner-started runs have no budget** (`turn.ts:187-193`; `research.ts:270-278`) (G11) |
| Audit                               | Action log, `via` and delegation ids; FeltKit audit trail; agent ledger                                                                                                                                                                                                                                      |

**Is there any model-caused action without a deterministic check?** None found that writes another person's data or bypasses AuthBoundry. Two weaker spots:

- Research spend on the owner's own account (G11).
- The "save" intent, which writes a confirmed memory (G25).

### I. Observability

| Question                                   | Where it is answered                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is it doing, and which task?          | PersonalOS continuity and Activity; the agent `GET /work/{id}`; the eve session stream                                                                                        |
| Which tools did it invoke?                 | The agent ledger (`appport_operations`, `appport_invocations`)                                                                                                                |
| Which model and dependencies did it use?   | PersonalOS: per generation. eve: dependency ref and revision on each operation; **the model is not recorded**                                                                 |
| What did it change?                        | The PersonalOS action log with read-back evidence                                                                                                                             |
| What failed, and what needs approval?      | Proposals in chat; `indeterminate` for operator settlement (`operations.ts:628-690`); research states                                                                         |
| Waiting, running, interrupted or complete? | Work states; session stream                                                                                                                                                   |
| Did it recover from a crash?               | Ledger transitions; recovery reconcile (`recovery.ts:257-261`)                                                                                                                |
| Is it safe to retry?                       | The ledger answers this explicitly (`indeterminate` = not safe)                                                                                                               |
| Operator tooling for self-hosted eve       | No dashboard. OpenTelemetry export, `GET /eve/v1/info`, `eve remote connect` (`docs/guides/deployment/self-hosting/index.md:73-77`). `eve logs` and `eve traces` are dev only |

### J. Deployment and lifecycle

| Item                                            | Finding                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How eve starts                                  | Separately: `eve build`, then `eve start --host 0.0.0.0` (`self-hosting/index.md:35-38`). PersonalOS does not start it                                                                                                                                                                                |
| Process boundary                                | Two processes. FeltKit cannot host eve in-process (`feltkit/docs/COMPONENTS.md:16-24`)                                                                                                                                                                                                                |
| eve persistence                                 | Local World plus local FeltDB: needs a persistent volume and **exactly one process** (`workflow-worlds.md:24-30`; agent README). Postgres World for replicas; no Postgres exists in Boundry                                                                                                           |
| PersonalOS persistence (hosted)                 | Managed FeltDB (`FELTDB_URL`, `FELTDB_APPLICATION_ID`, `FELTDB_TOKEN`, `FELTDB_ENVIRONMENT`; `feltkit/packages/sdk/src/runtime/targets.ts:144-170`)                                                                                                                                                   |
| PersonalOS local authority (hosted)             | **Needs a persistent `FELTKIT_AUTHORITY_DIR`**, else it lands on ephemeral disk (`feltkit/packages/sdk/src/runtime/local-authority.ts:172-181`). Not in the hosted contract                                                                                                                           |
| PersonalOS credential vault (hosted)            | X's rotating grant needs `FELTKIT_CREDENTIAL_VAULT=database` plus a key (`feltkit/docs/OAUTH-CREDENTIALS.md:98`). Not listed in the hosted contract                                                                                                                                                   |
| Instances                                       | One. FeltKit live updates are not cross-process (`GUARANTEES.md:208-211`), despite targets.ts claiming "any number"                                                                                                                                                                                   |
| Background workers and schedules                | In process for both. eve: run schedules on one replica only (`self-hosted-operations.md:35-37`)                                                                                                                                                                                                       |
| Secrets                                         | PersonalOS: `FELTKIT_CREDENTIAL_<ID>`, AuthBoundry, Resolver, search, X. eve: `ANTHROPIC_API_KEY`, `AGENT_JWT_SECRET`, `APPPORT_AGENT_IDENTITY_*`, agent credential file, `RESOLVER_*`, `APPPORT_AGENT_*` (full list in `examples/appport-agent/agent/lib/*`)                                         |
| Health                                          | PersonalOS `GET /_feltkit/health`; eve `GET /eve/v1/health`                                                                                                                                                                                                                                           |
| Graceful shutdown and upgrade                   | **eve upgrades strand in-flight sessions** (G23). PersonalOS: publish the contract, then start the image; rollback by starting the previous image (`targets.ts:168-169`)                                                                                                                              |
| Fly dependencies                                | PersonalOS: the X callback, `FELTKIT_PUBLIC_URL`, vault and authority data on the Fly volume, app data on the volume (`personalOS/docs/X.md:198-215`). **Managed FeltDB itself runs on Fly** (`flow_db/deploy/README.md:5-10`). FeltKit writes a `fly.toml` into every artifact (`deploy.ts:530-620`) |
| Backup and recovery                             | Managed: Fly volume snapshots kept 7 days, operator-only restore, "Restart recovery … not verified" (`flow_db/public-docs/managed-production.md:14,288,341-348`). eve: back up `.eve/` and the work directory                                                                                         |
| Migrating existing Fly data into Managed FeltDB | **No documented path.** There is "no developer-facing backup download or restore API on managed" (`managed-production.md:348`)                                                                                                                                                                        |

## 4. Implemented, available, missing

| Capability                                 | Implemented and connected               | Available, not connected | Missing                                                     |
| ------------------------------------------ | --------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| Delegated execution with per-person grants | ✓ (PersonalOS ↔ eve, tested)            |                          | Under hosted AuthBoundry                                    |
| Exactly-once agent writes                  | ✓ (ledger plus durable `/appport` keys) |                          |                                                             |
| Completion gate and stall detection        | ✓                                       |                          | Eager recovery at boot                                      |
| Replaceable AppPort dependency             | ✓ (example layer)                       |                          | Framework feature (proposed); Resolver re-pin compatibility |
| Replaceable model                          | ✓ PersonalOS own assistant              | eve `defineDynamic`      | eve Resolver model refs (proposed)                          |
| In-app chat through eve                    |                                         | eve session API          | Routing decision and wiring (Q1)                            |
| Approval waits in eve                      |                                         | `ask`, tool approval     | Surface for them in PersonalOS                              |
| Schedules and proactive work               | PersonalOS job chains                   | eve schedules            | A standing agent loop; durable principal beyond 7 days      |
| Subagents                                  |                                         | ✓                        |                                                             |
| Cancel agent work                          |                                         | eve cancel route         | Endpoint on `/work`, plus PersonalOS operation and UI       |
| Push or e-mail notification                |                                         |                          | ✓                                                           |
| Content search                             |                                         | FeltKit `search:` fields | Wiring; document content index                              |
| Hosted deployment of both                  | PersonalOS artifact build               |                          | Host, data plane, authority persistence, agent home         |

## 5. Scenario feasibility

| #   | Scenario                                          | Class                                                               | Path and precise blocker                                                                                                                                                                                                             |
| --- | ------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Research a topic and produce a reviewable result  | **Works today** (PersonalOS)                                        | Chat → `startResearch` → job pipeline with checked quotes and the run detail UI (`research.ts`; `src/research.tsx:63`). Needs a search credential and a model. Through eve: `research.start` is delegable, with the budget enforced. |
| 2   | Delegate a multi-step project and leave           | **Works for surface requests; needs wiring in-app**                 | Multiplayer and X → eve `/work` → durable session; PersonalOS follows for 24 h. In-app chat is request-scoped and cancelled on disconnect (`docs/LIMITATIONS.md:26-27`), and does not reach eve (Q1, G8).                            |
| 3   | Remember across sessions                          | **Works today**                                                     | Memory collection, auto-injected by keyword (`turnstate.ts:59-67`). eve only through `memory.list`.                                                                                                                                  |
| 4   | Create and update records                         | **Works today**                                                     | In-app: by proposal and approval. eve: delegated tasks, projects, documents, memory proposals (tested). Delete stays human-only.                                                                                                     |
| 5   | Periodically review state and propose useful work | **Requires a runtime change**                                       | Check-ins and the weekly review exist as job chains, but are deterministic summaries. No standing agent loop. The person's work is refused once they have no session for 7 days (G13).                                               |
| 6   | Wait for approval before a sensitive action       | **Works in-app; requires wiring for eve**                           | Proposals and `actions.approve` with `approval: "required"`. eve has `ask` and tool approval but no surface for them; grants are standing consent; irreversible actions are not delegable.                                           |
| 7   | Specialist subagents                              | **Configuration or wiring only**                                    | eve subagents exist; the agent defines none.                                                                                                                                                                                         |
| 8   | External services and user-connected accounts     | **Partial**                                                         | Search and X work with operator credentials. No per-user OAuth connections in PersonalOS. eve supports them, but they need user-principal callers.                                                                                   |
| 9   | Switch an AppPort implementation without redeploy | **Works** (example layer, tested 13/13)                             | It depends on a deployed Resolver with an outbound policy. A re-pin to a breaking contract is accepted by Resolver; eve then refuses it at use, so it fails safe but not early (G15).                                                |
| 10  | Switch model without redeploy                     | **Works for PersonalOS's own assistant; requires a change for eve** | Resolver model ref versus a static Anthropic model (G17).                                                                                                                                                                            |
| 11  | Survive a crash mid-operation                     | **Works** (tested: slices 1, 4, 6, 8)                               | Ledger plus World plus durable keys. In-flight sessions do not survive an eve **version upgrade** (G23).                                                                                                                             |
| 12  | Inspect what happened and why                     | **Mostly works**                                                    | Action log, continuity, research sources, agent records. The eve model is not recorded; approved model proposals are logged as `via: "ui"` (G12).                                                                                    |
| 13  | Stop, redirect or resume a task                   | **Partial**                                                         | Research cancel and turn abort exist. No cancel for agent work or invocations (G19). Resume is automatic.                                                                                                                            |
| 14  | Multiple users without leakage                    | **Works** (owner scoping, per-person grants, tests)                 | eve sessions have no ownership check; safe only because `/eve/v1` is operator-only (G9).                                                                                                                                             |
| 15  | Operate for days or weeks unattended              | **Requires platform and runtime changes**                           | Session-bound durable work (G13); lazy eve recovery; upgrades strand sessions; schedules unverified end to end.                                                                                                                      |

## 6. Layer ownership

| Capability                                                                                     | Owner                                                                                                 | Notes from code                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Conversation UX, approvals UI, task and project management, memory semantics, research product | PersonalOS                                                                                            | Already there                                                                                                   |
| Whether in-app chat routes to eve                                                              | PersonalOS (product decision)                                                                         | The `agent` integration contract already exists                                                                 |
| Cancel of agent work                                                                           | **eve agent** (`/work/{id}/cancel` calling the session cancel) **plus PersonalOS** (operation and UI) | eve already has session cancel                                                                                  |
| Durable principal for long-running work (beyond session TTL)                                   | **FeltKit**                                                                                           | `#resolveDurable` uses a live key or session (`runtime.ts:990-1006`); app agents are exempt (`runtime.ts:1022`) |
| Hosted AuthBoundry agent credentials (`aga_…`) held and presented                              | **FeltKit**                                                                                           | AuthBoundry server side exists (`authboundry/crates/server/src/agent_credentials.rs`)                           |
| Hosted contract listing the authority and vault variables                                      | **FeltKit**                                                                                           | `targets.ts:150-156`                                                                                            |
| Workflow persistence for eve                                                                   | **eve** (World), **not FeltDB**                                                                       | No FeltDB World. Use local (volume) or Postgres. A FeltDB World would be a new contract (Q4)                    |
| Session ownership enforcement                                                                  | **eve**                                                                                               | `auth-and-route-protection.md:323`                                                                              |
| Eager recovery at boot, agent schedules                                                        | **eve agent**; eve has the schedule primitive                                                         | `work.ts:102-110`                                                                                               |
| Dependency resolution as a framework feature                                                   | **eve** (research, unapproved)                                                                        | Proposal only                                                                                                   |
| Re-pin compatibility, staged bindings                                                          | **Resolver**                                                                                          | `targets.ts:100-126`; `protocol.ts:49`                                                                          |
| Managed data plane location                                                                    | **FeltDB plus infrastructure**                                                                        | Production on Fly; Hetzner `feltdb-managed` unprovisioned for apps (`appboundry deploy/boundry/PLATFORM.md:19`) |
| Host placement and ingress                                                                     | **Deployment infrastructure (human decision)**                                                        | Shared host forbids customer execution (`deploy/staging-host/README.md:7`; `SHARED-HOST.md`)                    |
| Where the PersonalOS eve agent lives                                                           | **PersonalOS's agent application, not the eve framework**                                             | Today it is `eve2/examples/appport-agent`                                                                       |

**Hypotheses challenged:**

- **"FeltDB owns eve workflow persistence"** is wrong. eve's durability contract is the Workflow World.
- **"eve runs inside PersonalOS"** is wrong. They are two processes and must stay so; FeltKit components are same-process only.
- **"Durable scheduling belongs in eve"** is correct for agent loops. But PersonalOS's own reminders and reviews are application jobs and should stay in PersonalOS.

## 7. Gap register

**Abbreviations.**

- Types: **MI** missing implementation · **NC** existing, not connected · **NE** not exposed to users · **MC** missing contract between layers · **MT** missing tests or evidence · **DC** deployment or configuration · **UF** upstream framework limitation.
- Size: **S** / **M** / **L**.
- Blocks deploy: **Y** = blocks the initial deployment.

| ID  | Pri | Type  | Capability                                     | Current reality and evidence                                                                                                                                                                                                                                                                        | Owner                                 | Required change                                                                                                                                                           | Deps              | Size            | Acceptance                                                                   | Tests                                                             | Blocks deploy                         |
| --- | --- | ----- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| G1  | P0  | DC    | A host for two processes                       | No documented path for a FeltKit container plus a Node service on Boundry. The shared host forbids customer execution (`appboundry/deploy/staging-host/README.md:7`; `PLATFORM.md:23-25`). FeltKit "Route A" is blocked on the same decision (`feltkit/docs/MILESTONE-FIRST-HOSTED-APP.md:114-123`) | Infrastructure (human)                | Choose: an existing host with explicit risk acceptance, or a dedicated one (Q2)                                                                                           | —                 | S (decision)    | A named host, volumes, ingress and a recorded acceptance                     | Smoke: both health endpoints; restart keeps state                 | Y                                     |
| G2  | P0  | DC    | Data plane and migration                       | Managed FeltDB production is on Fly (`flow_db/deploy/README.md:5-10`). The Hetzner `feltdb-managed` is unprovisioned for apps. No import into managed (`managed-production.md:348`). PersonalOS data is on the Fly volume today                                                                     | FeltDB plus infrastructure (human)    | Decide (Q3): managed on Fly for now, or self-hosted FeltDB or a volume on the host. Define the data migration or a fresh start                                            | G1                | M               | Records, grants and vault preserved or deliberately reset; documented        | Migration dry run with record counts and spot-reads               | Y                                     |
| G3  | P0  | UF/MC | Delegation authority in production             | Delegation works only with the local AuthBoundry (`feltkit/docs/LOCAL-AUTHORITY.md:145-146`), whose state needs a persistent dir (`local-authority.ts:172-181`). The hosted target is stateless                                                                                                     | FeltKit (long term); deployment (now) | **Now:** persistent `FELTKIT_AUTHORITY_DIR`, single instance, documented. **Later:** FeltKit holds and presents hosted AuthBoundry `aga_` credentials                     | G1                | S now / M later | eve's delegated calls succeed after a container restart; revocation honoured | The existing `agent-*-real` suites against the deployed processes | Y                                     |
| G7  | P1  | DC/MC | Owned home for the PersonalOS eve agent        | The agent is `eve2/examples/appport-agent`, an example in the framework repository                                                                                                                                                                                                                  | PersonalOS (or its own repo)          | Move or vendor it as PersonalOS's agent application, pinned to a released `eve`                                                                                           | release of `eve`  | M               | Builds from its own repo with a pinned eve; tests run there                  | Its suite (160) in that repo's CI                                 | Y (there is nothing proper to deploy) |
| G6  | P1  | MT/DC | CI evidence for eve                            | No runs visible; the cause is a repository setting. The PersonalOS and FeltKit suites skip in CI (`ci.yml:276-280`)                                                                                                                                                                                 | eve2 / the agent's repo               | Enable Actions; give the agent suite `PERSONALOS_DIR` and `FELTKIT_SDK_DIR` (or run it in the agent's repo)                                                               | G7                | S               | A green run that includes the PersonalOS suites                              | —                                                                 | Recommended before deploy             |
| G13 | P1  | MI    | Long-running work without a live session       | Jobs are refused once the creator has no active session (7-day default, no renewal found: `feltkit/packages/sdk/src/runtime/sessions.ts:51`; `runtime.ts:990-1006`)                                                                                                                                 | FeltKit                               | A durable, revocable principal for a person's standing work (for example a per-person work credential, or attributing to a declared app agent acting on recorded consent) | —                 | M               | A reminder fires 8 days after the last sign-in; revocation stops it          | Clocked runtime test                                              | N (needed for weeks of operation)     |
| G23 | P1  | UF    | eve upgrades                                   | In-flight sessions are stranded on upgrade (`workflow-worlds.md:10-16`)                                                                                                                                                                                                                             | eve                                   | **Now:** drain procedure (stop accepting `/work`, let work settle). **Later:** an upgrade contract                                                                        | —                 | S / L           | Upgrade runbook; no stranded work                                            | Upgrade drill                                                     | N (runbook needed)                    |
| G5  | P1  | MI    | Eager recovery and stall detection at boot     | Recovery runs on the first `/work` request (`examples/appport-agent/agent/channels/work.ts:102-110`)                                                                                                                                                                                                | eve agent                             | Reconcile at boot, or via an eve schedule                                                                                                                                 | G7                | S               | A stalled work item is detected with no inbound traffic                      | Kill and restart test without requests                            | N                                     |
| G4  | P1  | DC    | Hosted vault and authority variables           | `FELTKIT_CREDENTIAL_VAULT=database` exists but is not in the hosted contract (`targets.ts:150-156`)                                                                                                                                                                                                 | FeltKit                               | Add to the hosted contract and docs                                                                                                                                       | —                 | S               | `.env.example` lists them; readiness checks them                             | Deploy test                                                       | Y if X is enabled                     |
| G9  | P1  | MI    | eve session ownership                          | Route authentication checks the caller only (`auth-and-route-protection.md:323`)                                                                                                                                                                                                                    | eve                                   | Bind a session to its initiator, or document the operator-only pattern                                                                                                    | —                 | M               | A non-initiator cannot attach or post                                        | Route tests                                                       | N while `/eve/v1` stays operator-only |
| G8  | P2  | NC    | In-app chat through eve                        | Only Multiplayer and X hand off (`interactions.ts:201`; `xsurface.ts:371`)                                                                                                                                                                                                                          | PersonalOS (decision Q1)              | Route chosen requests through `agent.submit` and the follow job                                                                                                           | Q1                | M               | A chat request becomes durable agent work, visible in chat                   | PersonalOS test with a stand-in agent                             | N                                     |
| G19 | P2  | MI    | Cancel agent work                              | No cancel on `/work`; PersonalOS has no operation                                                                                                                                                                                                                                                   | eve agent plus PersonalOS             | `POST /work/{id}/cancel` → session cancel; PersonalOS `agent.cancel` and UI                                                                                               | —                 | S               | Cancel stops further operations; the ledger stays consistent                 | Cancel mid-work test                                              | N                                     |
| G11 | P2  | MI    | Spend control on owner research                | The model starts research without approval; no budget for owner runs (`turn.ts:187-193`; `research.ts:270-278`)                                                                                                                                                                                     | PersonalOS                            | Owner research budget or confirmation                                                                                                                                     | —                 | S               | A run is refused or asks above the budget                                    | Research test                                                     | N                                     |
| G12 | P2  | MI    | Model provenance on approved proposals         | Logged as `via: "ui"`; `via: "model"` is never set                                                                                                                                                                                                                                                  | PersonalOS                            | Carry `proposedBy` into the action meta                                                                                                                                   | —                 | S               | The action log shows the model and approver                                  | Turn test                                                         | N                                     |
| G25 | P2  | MI    | Inferred "save" stored as confirmed            | `invocationstate.ts:180`                                                                                                                                                                                                                                                                            | PersonalOS                            | Store as `inferred` when the intent came from the model                                                                                                                   | —                 | S               | Model-classified saves need confirmation                                     | Invocation test                                                   | N                                     |
| G17 | P2  | MI    | eve model replaceable and recorded             | Static model (`agent.ts:4-7`); model not in the ledger                                                                                                                                                                                                                                              | eve (proposal) / agent                | Record the model per turn now; Resolver model refs once approved                                                                                                          | research approval | S / M           | The ledger shows the model; changing it needs no rebuild                     | Agent test                                                        | N                                     |
| G15 | P2  | MI    | Resolver re-pin compatibility, staged bindings | `targets.ts:100-126`; `protocol.ts:49`                                                                                                                                                                                                                                                              | Resolver                              | Classify a re-pin against the previous binding; add an inactive state                                                                                                     | —                 | M               | A breaking re-pin needs explicit acceptance                                  | Resolver tests                                                    | N                                     |
| G16 | P2  | MI    | Dependency resolution in the framework         | Example-layer only                                                                                                                                                                                                                                                                                  | eve (research, unapproved)            | As the approved proposal                                                                                                                                                  | approval          | L               | Per the research document                                                    | Per the research document                                         | N                                     |
| G18 | P2  | NC    | Search across memory, projects and documents   | `search:` declared, `ctx.db.search` unused; contents unread                                                                                                                                                                                                                                         | PersonalOS                            | Wire search; a capability for document contents                                                                                                                           | —                 | M               | Recall finds by content                                                      | PersonalOS tests                                                  | N                                     |
| G20 | P2  | MI    | Out-of-app notification                        | In-app inbox and webhooks only                                                                                                                                                                                                                                                                      | PersonalOS (via AppPort Services)     | Push or e-mail through an existing service                                                                                                                                | —                 | M               | The person is told when work completes                                       | —                                                                 | N                                     |
| G21 | P2  | NE    | Operator view of eve                           | No dashboard; OpenTelemetry available                                                                                                                                                                                                                                                               | eve agent / operator                  | OTel export plus a runbook                                                                                                                                                | G1                | S               | Traces visible for a work item                                               | —                                                                 | N                                     |
| G10 | P3  | DC    | `VERCEL_ENV` production detection              | `dev-environment.ts:28-31`                                                                                                                                                                                                                                                                          | eve                                   | Never set it off Vercel (runbook); or an explicit mode                                                                                                                    | —                 | S               | —                                                                            | —                                                                 | N                                     |
| G22 | P3  | UF    | More than one instance                         | Local authority, local World, FeltKit live updates                                                                                                                                                                                                                                                  | FeltKit, eve                          | Postgres World; hosted authority (G3 later)                                                                                                                               | G3                | L               | —                                                                            | —                                                                 | N                                     |
| G24 | P3  | DC    | Fly residue                                    | X callback, public URL, `fly.toml` in artifacts                                                                                                                                                                                                                                                     | PersonalOS operator, FeltKit          | Re-register the callback; optional `fly.toml`                                                                                                                             | G1                | S               | No `fly.dev` origin in configuration                                         | —                                                                 | N                                     |

## 8. Minimum viable deployment (H1)

**What it is:** one operator-owned account, PersonalOS and its eve agent, with no customers.

1. **Host (G1).** A named host with two containers on a private network: PersonalOS (`feltkit start` from the hosted or container artifact) and the eve agent (`eve start`). Ingress only to PersonalOS, plus eve's `/eve/v1` for the operator.
2. **Volumes.**
   - PersonalOS: `FELTKIT_AUTHORITY_DIR`, plus a database or file vault (G3, G4).
   - eve: `.eve/` (the World) and `APPPORT_AGENT_WORK_DIR`.
   - One instance each.
3. **Data plane (G2).** Either Managed FeltDB, keeping its Fly dependency until FeltDB's own cutover, or a FeltDB on the host. Migrate or reset deliberately.
4. **Secrets.**
   - PersonalOS: `RESOLVER_*`, search credentials, model access through its Resolver reference.
   - eve: `ANTHROPIC_API_KEY`, `AGENT_JWT_SECRET`, `APPPORT_AGENT_IDENTITY_PUBLIC_KEY` / `_ISSUER` (PersonalOS's `agent-identity` key pair), the agent credential file, `RESOLVER_URL` / `RESOLVER_API_KEY` / `APPPORT_AGENT_DEPENDENCY`, `APPPORT_AGENT_CAPABILITIES`.
   - Set `PERSONALOS_AGENT_URL` only if surfaces are enabled.
5. **Authority.** `delegation.registerAgent`, then the person's `delegation.set` for the chosen capabilities.
6. **Acceptance.**
   - The PersonalOS and agent suites pass against the deployed processes.
   - A restart of either keeps work, grants and links.
   - A revocation is honoured.
   - No secrets appear in logs.
7. **Runbooks.** eve upgrade drain (G23); backups of both volumes.

**Excluded from H1:** X and Multiplayer (unless explicitly wanted), customer traffic, multiple instances and business delegation.

## 9. Implementation slices

### A. Minimum to deploy safely

**A1. Agent home and evidence (G7, G6).**

- **Becomes available:** a deployable, versioned PersonalOS agent with CI.
- **Repository:** PersonalOS (an `agent/` application) or a new agent repository; eve2 settings for Actions.
- **Why there:** the agent is PersonalOS's product logic on eve, not framework code.
- **Depends on:** a released `eve`.
- **Proof:** its 160-test suite green in CI with the PersonalOS suites enabled.
- **Blocks deploy:** yes.

**A2. Deployment profile (G1–G4).**

- **Becomes available:** H1.
- **Repository:** deployment configuration, plus FeltKit (hosted contract variables, G4).
- **Why there:** FeltKit owns the hosted contract.
- **Depends on:** decisions Q2 and Q3.
- **Proof:** the §8 acceptance list, run against the deployed processes.
- **Blocks deploy:** yes.

### B. A dependable delegated agent

**B1. Eager recovery and cancel (G5, G19).**

- **Repository:** the agent, plus PersonalOS (operation and UI).
- **Proof:** restart with no traffic detects the stall; cancel mid-work leaves a consistent ledger.

**B2. Work beyond the session lifetime (G13).**

- **Repository:** FeltKit (durable principal), plus PersonalOS adoption.
- **Proof:** a clocked test across 8 days; revocation stops the work.

**B3. Provenance and spend (G12, G25, G11, G17-record).**

- **Repository:** PersonalOS, plus the agent.
- **Proof:** the action log shows the model and approver; a model "save" is inferred; owner research has a budget; the ledger shows the model.

### C. Proactive, persistent, increasingly useful

**C1. In-app chat through eve (G8, Q1).**

- **Repository:** PersonalOS.
- **Proof:** a chat request survives the user disconnecting and completes visibly.

**C2. Standing agent loop.**

- **Repository:** the agent (eve schedule), using B2.
- **What it does:** periodically reads tasks and projects through delegated reads, writes `memory.propose` and task proposals, and never acts irreversibly.
- **Proof:** a schedule produces proposals only.

**C3. Search and knowledge (G18).**

- **Repository:** PersonalOS.

**C4. Framework dependency and model resolution (G16, G17, G15).**

- **Repository:** eve, per the approved research; Resolver for G15.

**C5. Hosted authority and multi-instance (G3 later, G22).**

- **Repository:** FeltKit, plus an eve Postgres World.

## 10. Questions that need a human decision

1. **Should in-app chat be answered by eve?**
   - Today eve serves only Multiplayer and X.
   - Options: (a) keep PersonalOS's own assistant for chat, with eve for delegated and background work; (b) route long or multi-step requests to eve; (c) route everything to eve.
   - (b) keeps the product functional without eve and is the smallest change.
2. **Which host runs PersonalOS and its agent?** Boundry's own documents forbid customer execution on the shared host. A dedicated host means new spend; an existing one means an explicit risk acceptance.
3. **Managed FeltDB now (on Fly), or a FeltDB on the host until FeltDB's Hetzner cutover?** Also: migrate the Fly data, or start fresh? No documented import exists.
4. **eve's workflow persistence: local World on a volume (single instance) or Postgres?** Should a FeltDB World ever be pursued? It would be a new contract, and nothing today requires it.
5. **Where should the PersonalOS agent live:** the PersonalOS repository, or its own?
6. **Should Multiplayer and X be part of H1?** X needs the callback moved and a writable vault.
7. **Should owner-started research and model-chosen saves require confirmation (G11, G25), or is the current behaviour intended?**

## 11. Already implemented: do not rebuild

- PersonalOS:
  - deterministic assistant;
  - model-as-proposer with owner approval (FeltKit `ctx.agent`);
  - owner scoping;
  - action log with read-back evidence;
  - research pipeline with verbatim-checked sources and budgets for agents;
  - reminders, check-ins and weekly review job chains;
  - Resolver model reference;
  - identity linking;
  - Multiplayer and X surfaces;
  - continuity view.
- FeltKit:
  - delegated `/appport` with exact per-capability grants proven as the agent;
  - durable idempotency replay;
  - jobs re-authorized per attempt;
  - credential custody;
  - verified deploy artifacts.
- eve: durable sessions, approvals, `ask`, hooks, `sleep`, schedules, subagents, cancel, steering, channels, OpenTelemetry.
- The PersonalOS eve agent:
  - operation ledger with exactly-once sends;
  - completion gate;
  - stall detection;
  - reconciliation and operator settlement;
  - ES256 identity authority;
  - Resolver-resolved, contract-pinned AppPort dependencies with implementation identity per operation.
- Resolver: refs, revisions, compare-and-set, history, verified rollback, `agent` and `model` kinds, production outbound policy.
- AuthBoundry: agents, delegations and non-interactive agent credentials (`aga_…`) server-side.

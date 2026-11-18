# Personal OS projects and documents through eve

This is Slice 2c of [`CAPABILITY-PORT-BACKLOG.md`](CAPABILITY-PORT-BACKLOG.md).

**Result.** Each with its own grant, eve can:

- list a person's projects, create them, and update them (name, description, status);
- list their documents (metadata only);
- re-file a document: its note, and which of the person's projects or tasks it is attached to.

**Boundaries:**

- **Separate grants.** A project grant exposes no documents.
- **Not available to an agent:** a document's bytes (upload), its bearer download link, and its removal. The source says removal is the person's own act.
- **Personal OS's own rules apply unchanged:** ownership, one project per name, and Files ownership.
- **Records:** every agent write is recorded in Personal OS's action log with the agent and the AuthBoundry decision, linked to eve's operation.

Personal OS remains the only store. eve has no project or document tool, logic or store.

## Repositories

| Repository  | Revision                                                                                       | Note                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal OS | `claude/dreamy-galileo-4z03p5` (`b540651`), fast-forwarded to `main` `dab0296` before starting | `main` contains Slices 2a and 2b (PRs #25, #27) and PR #26, which updates test fixtures only (AuthBoundry 1.19.0, Resolver 0.4.1). The fixtures were reinstalled |
| FeltKit     | `main` `d68219c`                                                                               | Unchanged. Still in no published release: npm `latest` is 0.3.31 and `pending` is 0.3.32                                                                         |
| eve2        | `claude/dreamy-galileo-4z03p5` from `989739c`                                                  | Tests and docs only                                                                                                                                              |

## Source capabilities (inspected before changing)

| Function                                 | Published before                          | Contract                                                                                         | Ownership and lifecycle                                                                                     |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `projects.ts` `list`                     | `projects.list` (read, `projects.read`)   | `{}` → the owner's projects with `open` and `done` task counts                                   | `owner = me(ctx)`                                                                                           |
| `projects.ts` `create`                   | no                                        | `{ name, description? }` → project; `_ops.createProject`                                         | Name unique per owner (`FAILED_PRECONDITION`); status `active`; verified read-back; action `project.create` |
| `projects.ts` `update`                   | no                                        | `{ id, name?, description?, status? }` → nothing                                                 | `own()` check; status `active`, `paused` or `done`; **no action record, no read-back**                      |
| (none)                                   | —                                         | —                                                                                                | There is no project deletion                                                                                |
| `documents.ts` `list`                    | `documents.list` (read, `documents.read`) | `{ projectId?, taskId? }` → the owner's document records                                         | `owner = me(ctx)`. Records hold name, size, contentType, note, fileId, projectId and taskId; never contents |
| `documents.ts` `prepareUpload`, `attach` | no                                        | Upload link (owner fixed in its metadata) → browser `PUT` of the bytes → `attach` binds the file | The file must be the caller's and made for Personal OS; the project or task must be the caller's            |
| `documents.ts` `update`                  | no                                        | `{ id, note?, projectId?, taskId? }` → nothing                                                   | `own()` on the document and on any target project or task; **no action record**                             |
| `documents.ts` `link`                    | no                                        | `{ id }` → a 120-second download URL                                                             | "Holding the link is enough to download"                                                                    |
| `documents.ts` `remove`                  | no                                        | `{ id }`                                                                                         | "**The person's own act, never the assistant's**": deletes the record and the bytes                         |

**Relationships.** A document has an optional `projectId` or `taskId`. Document reads are their own permission (`documents.read`), independent of `projects.read`. The source does not establish that project access implies document access, so it doesn't here.

**Approval.** Personal OS's assistant and its connected surfaces create projects directly on request (`assistant.ts` `project.create`; the surface capability `personalos.projects.create`). Only destructive acts (forgetting, deleting) go through approval proposals. So no new approval workflow was added.

**Tenancy.** Personal OS doesn't use FeltKit tenancy (no `auth.tenant`). The cross-tenant boundary is therefore the cross-person boundary, and that is what was tested.

## Delegation boundaries

| Capability                         | Delegable          | Change                                                                                                                                                                    |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.list`                    | Yes, its own grant | Listed in `authority.capabilities`                                                                                                                                        |
| `projects.create`                  | Yes, its own grant | **Published** (existing function, unchanged logic)                                                                                                                        |
| `projects.update`                  | Yes, its own grant | **Published.** Now goes through `_ops.updateProject`: owner check, read-back verification, and a `project.update` action, so the change is evidenced. Returns the project |
| `documents.list`                   | Yes, its own grant | Listed                                                                                                                                                                    |
| `documents.update`                 | Yes, its own grant | **Published.** Now verifies its write and records a `document.update` action. Returns the document                                                                        |
| Upload (`prepareUpload`, `attach`) | **No**             | Bytes move by an HTTP `PUT` to a single-use link, outside AppPort. eve's three tools cannot carry them, and adding that is a new contract, outside this slice             |
| `link`                             | **No**             | A bearer URL to the contents: anyone holding it can download. eve has no fetch tool, and handing out bearer links widens exposure                                         |
| `remove`                           | **No**             | The source makes removal the person's own act                                                                                                                             |

`delegation.set` refuses to grant an agent anything outside the allowlist. The unpublished operations are not capabilities on `/appport` (`UNKNOWN_CAPABILITY`).

**Direct behavior.** The direct-person path is unchanged except that it is now evidenced:

- **New action records:** `projects.update` and `documents.update` write a `project.update` or `document.update` action for every caller, the person included.
- **Return values:** both now return the updated record (the UI ignored the previous empty result).
- **Tests:** Personal OS's existing project and Files tests still pass.

## Provenance

The same as Slices 2a and 2b; no new audit system:

| Question                                | Evidence                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person                                  | Action `owner`; audit `principal`                                                                                                                 |
| Agent, capability, decision, delegation | Action `via: "agent"`, `delegation.{agent, agentAuthority, capability, decisionId, delegationId}` (from FeltKit's verified `ctx.auth.delegation`) |
| Request                                 | FeltKit audit `requestId` equals eve's `operation.request_ids[0]`. The audit's `authority.delegation.decisionId` equals the action's              |
| Result and time                         | Action `status`, `evidence` (`verified: true`, from the read-back) and `createdAt`; eve's operation `state` and `outcome`                         |

## Test evidence

**Every test below used real services:** FeltKit HTTP `/appport`, the real `@authboundry/local`, FeltDB, real Files storage, and Personal OS's own functions. eve's model is scripted. Nothing in the authorization, data or file path is mocked.

Personal OS `tests/agent-projects-documents-real.test.ts`:

- **Setup:** documents are saved through the person's own upload path.
- **Refusals:** every refusal asserts that the owner's projects, documents **and** action log are unchanged.

| #     | Required case                                              | Observed                                                                                                                                                                        |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3   | Project reads delegable; denied without; only the person's | `FORBIDDEN`, then Ada's `Taxes` only (Grace's `Garden` exists)                                                                                                                  |
| 10    | A project grant exposes no documents                       | `documents.list`, even filtered to Ada's own project: `FORBIDDEN`                                                                                                               |
| 4     | Create and update need their grants                        | Each `FORBIDDEN` until granted                                                                                                                                                  |
| 14    | No duplicates                                              | The same key replays the same project; a new key with the same name → `feltkit.FAILED_PRECONDITION` (Personal OS's rule); one `Kitchen`                                         |
| 5, 18 | Lifecycle and ownership                                    | `status: paused` set on Ada's project; Grace's project id → `NOT_FOUND`, Grace's unchanged                                                                                      |
| 6, 7  | Document reads delegable; only the person's                | Ada's two documents; filtered by `Taxes` → `w2.txt` only; Grace's project → none; no `url` or `content` fields                                                                  |
| 8, 9  | Document update needs its grant; relations correct         | `FORBIDDEN` until granted; then `lease.txt` moves to `Kitchen` with a note, visible on Personal OS's own read; to Grace's project → `NOT_FOUND`; Grace's document → `NOT_FOUND` |
| 18    | Not delegable                                              | `documents.link`, `documents.remove`, `documents.upload` and `documents.attach` → `UNKNOWN_CAPABILITY`, and none can be granted                                                 |
| 11    | Cross-person                                               | Grace granted nothing: `FORBIDDEN`                                                                                                                                              |
| 12    | Revocation                                                 | `documents.list`, `projects.update` → `FORBIDDEN`                                                                                                                               |
| 17    | Provenance                                                 | Actions `project.create`, `project.update` and `document.update` via `agent`, with the delegation; audit linked by decision id                                                  |
| 16    | Direct use                                                 | Ada's own update recorded `via: ui` with no delegation; her own removal works                                                                                                   |

eve end to end (`examples/appport-agent/test/personalos.test.mjs`, the third `describe`):

- **eve:** real `eve start`.
- **Personal OS:** a real server process with its private AuthBoundry.
- **Documents:** uploaded by Ada over HTTP exactly as the browser does: `documents:prepareUpload`, then a `PUT` of the bytes, then `documents:attach`.

| Case                                            | Observed                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project reads                                   | `FORBIDDEN` without a grant; then `Taxes` listed; `documents.list` with only a project grant → `FORBIDDEN`; Grace → `FORBIDDEN`                                                  |
| Create and update                               | Each `FORBIDDEN` until granted. `[repeat]` create: one operation, one request, one `Kitchen`; action `via: agent` linked to the audit and eve's request id; update sets `paused` |
| Duplicate name                                  | Personal OS refuses (`feltkit.FAILED_PRECONDITION`); eve leaves the operation **indeterminate**, not retried; still one `Kitchen` (see the deferred finding)                     |
| Document reads                                  | Names listed, contents (`rent 900`, `wages 100`) never in the result; `documents.link` → not a capability                                                                        |
| Document update                                 | `FORBIDDEN` until granted; then `lease.txt` attached to `Kitchen` with its note, `w2.txt` still on `Taxes`; action `document.update` via agent, verified                         |
| 15: eve and Personal OS killed after the commit | Attempt 2, same key, replayed; one `Garage`                                                                                                                                      |
| Revocation                                      | Both reads `FORBIDDEN`                                                                                                                                                           |

**Mutation checks.** Each was applied to Personal OS, the test was run, and the change was restored. **All were caught**:

| Mutation                                              | Caught by                                        |
| ----------------------------------------------------- | ------------------------------------------------ |
| Project ownership check removed (`updateProject`)     | Grace's project changed through Ada's delegation |
| A project-read grant also grants document reads       | "project reads do not expose documents"          |
| Revocation ignored                                    | "revoked" call allowed                           |
| A write without its own grant (create implies update) | "update not granted" allowed                     |
| Delegation provenance dropped from the action log     | Action fields                                    |
| Document ownership check removed                      | Grace's document changed                         |

## Test commands and results

| Command                                                                               | Result                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Personal OS `feltkit test tests/agent-projects-documents-real.test.ts` (FeltKit main) | **1 of 1**                                                                                              |
| Personal OS `feltkit test` (full suite, FeltKit main)                                 | **152 of 152**                                                                                          |
| Personal OS `feltkit test` on the pinned published FeltKit 0.3.30                     | **149 passed, 3 skipped** (the three delegation tests, each saying FeltKit has no delegated `/appport`) |
| Personal OS `tsc --noEmit`, FeltKit main and 0.3.30                                   | Clean on both                                                                                           |
| FeltKit `test/delegated-appport.test.ts`                                              | **1 of 1**                                                                                              |
| eve2 `PERSONALOS_DIR=… node --test test/personalos.test.mjs`                          | **20 of 20** (9 tasks, 5 memory, 6 projects and documents)                                              |
| eve2 full suite, with `FELTKIT_SDK_DIR` and `PERSONALOS_DIR`                          | **111 of 111** (real-model block skipped: no key)                                                       |

**AuthBoundry processes.** Zero were left after each run.

**Not run:** Personal OS's UI, model and extension e2e scripts.

## Deferred defects and limitations

- **eve marks an application refusal as indeterminate.** FeltKit sends a precondition refusal (for example, a duplicate project name) as the extension code `feltkit.FAILED_PRECONDITION`, never applied and never retryable; it reports "may have been applied" separately as `OUTCOME_UNKNOWN`. eve's ledger only treats standard not-executed codes as `failed`. So this refusal becomes `indeterminate`: safe and never retried, but it needs an operator to settle. **Deferred:** the fix belongs in the eve ledger's classification, outside this slice.
- **Agents cannot add documents.** That needs a byte-carrying contract. Reading a document's contents is not available either; `link` is a bearer URL and eve has no fetch tool.
- **`documents.list` returns `fileId`** (an AppPort Services Files id). It can't be used to download without `link` or Files access, which agents don't have.
- **Task counts.** `projects.list` includes open and done task counts, so a project grant reveals counts, not tasks. That is the published contract as it stands.
- **Recorded, roadmap unchanged:**
  - FeltKit release pending;
  - no Settings screen for agent grants;
  - reminders need an active session;
  - AuthBoundry orphan processes, mitigated only in the test harnesses;
  - the memory existence oracle (Slice 2b).

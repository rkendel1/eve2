# Voice-agent delegated tools (slice 7): assessment

**Outcome:**

- **The slice is closed as not applicable.** No code was changed and no capability was migrated.
- **The cause is a category error in the roadmap item.** The voice agent is a multi-tenant business receptionist, not a person-facing Personal OS assistant. Its tools are business-domain capabilities and stay that way.
- **Forcing them through person-to-agent delegation would weaken the architecture.** It would treat an unauthenticated caller, or a business tenant, as a delegating person.

The closure was agreed with the roadmap owner after the source inspection below.

## Repository and commit evidence

| Repository             | State inspected                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rkendel1/voice-agent` | Default branch `claude/eager-ritchie-qazq3g` at `56e1f2c`, which is newer than `main` at `e65aa15`. Unchanged                                                                                  |
| `rkendel1/personalOS`  | `claude/dreamy-galileo-4z03p5` at `3c3e3c2`. The slice-6 commits `28c4573` and `3c3e3c2` were pushed but **not on main** (main was the slice-5 merge `c1c8b00`). See "Mainline baseline" below |
| `rkendel1/eve2`        | main at `0399594` (PR #16), containing slice 6 `66c7408`                                                                                                                                       |
| `rkendel1/feltkit`     | main at `d68219c`. Unchanged                                                                                                                                                                   |

## What the voice agent is (from source)

voice-agent is a FeltKit app: a phone and SMS agent for businesses.

- **Who calls:** members of the public call or text a business.
- **What the agent does:** it answers and acts on that business's data.
- **Tenancy:** each business is a FeltKit tenant.

| Concern                  | Source                                                          | Finding                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller identity          | `gateway/providers/twilio.ts`; the inbound `From`               | The caller is the phone number the provider reports. `X-Twilio-Signature` authenticates **Twilio's request**, not the caller; caller ID can be spoofed. There is no caller authentication                           |
| Who tools act for        | `feltkit/tools.ts`, `feltkit/_authz.ts`                         | The **business**: the voice runtime calls each tool as its own principal (role `voice`), inside the call's business tenant                                                                                          |
| Tool authorization       | `_authz.ts` `authorize`                                         | voice-agent's own policy: the business's agent profile must be active and list the capability, acting in a live call or existing conversation of that business. The model never chooses the agent, call or business |
| Idempotency and evidence | `tools.ts` `invoke`, `invocations` collection                   | Each call is keyed by the runtime's tool-call id (`<agent>:<call>:<seq>`); a repeat returns the first result. Every decision and result is recorded, along with an `audit` record                                   |
| FeltKit                  | `package.json`: `vendor/feltdb-feltkit-0.3.19-components.1.tgz` | Predates FeltKit's delegated `/appport` (slice 2.0) and AuthBoundry per-agent delegation                                                                                                                            |

## Tool inventory and disposition

| Tool (capability)           | What it does                                          | Personal OS or AppPort equivalent                                             | Disposition           |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------- |
| `contacts.lookup`           | The caller's contact record and upcoming appointments | None (business contacts, not a person's)                                      | Stays business-scoped |
| `business.info`             | The business's name, hours, open now                  | None                                                                          | Stays business-scoped |
| `appointments.availability` | Free slots in business hours                          | None                                                                          | Stays business-scoped |
| `appointments.book`         | Book a slot (unique slot key)                         | None                                                                          | Stays business-scoped |
| `followups.create`          | A staff task for the business                         | None. Personal OS tasks are a person's own; these are a business's work queue | Stays business-scoped |
| `sms.send`                  | Text the caller, under the business's policy          | None                                                                          | Stays business-scoped |
| `calls.transfer`            | Transfer to an escalation contact                     | None                                                                          | Stays business-scoped |
| `conversations.history`     | Texts and call summaries with this contact            | None                                                                          | Stays business-scoped |

**No tool duplicates a Personal OS capability**, so there is nothing to consolidate. These tools are what the capability inventory lists as OA-voice-03–08 and 10. They remain in the inventory, reclassified from "Contract adaptation" to **business-scoped, outside the person-delegation path**.

## Why the planned integration does not apply

1. **There is no authenticated person on a voice session.**
   - A delegated side effect needs an authenticated person. This slice's own rule says an unauthenticated or ambiguously identified session must not perform one.
   - Caller ID is not authentication. Under slice 5's rule, a surface with no trustworthy verification stays unlinked.
2. **The tools act for a business, not a person.** AuthBoundry's delegation is person-to-agent, and the business is a tenant. Rebinding the tools to "the business owner's delegation" needs a business-as-principal authority model that does not exist.
3. **The platform path is missing.**
   - FeltKit's delegated `/appport` does not carry tenancy: `runtime/delegation.ts` has no tenant handling, as recorded in the slice 2.0 report.
   - Every voice tool is tenant-scoped.
   - voice-agent would also need a FeltKit upgrade, from 0.3.19 to a release with delegation.

## Deferred directions (not on the current roadmap)

| Direction                                                                                                                                             | Status                                              | Prerequisite                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Business-owner delegation** of the voice tools (backlog §7 as first written: "a booking made by the agent carries the business owner's delegation") | **Deferred: blocked on a real platform capability** | Tenant-scoped delegation in FeltKit, with a clear business-as-principal authority model (who grants for a business, how membership and roles map, how revocation and audit attach), in its **own approved slice**. Then a FeltKit upgrade in voice-agent. Not added to the current roadmap |
| **Personal OS by phone** (a person calls in to use their own Personal OS through eve)                                                                 | **Separate, unapproved direction**                  | Caller verification is a prerequisite and cannot be inferred from Twilio caller ID. A verification method (for example a per-call challenge bound to a person's session, or a callback to a verified number) would itself need a product decision and a slice-5-style verification         |

## What was not done

- No code, test or schema change in any repository.
- No new identity, authorization or messaging mechanism.
- No live voice-provider validation was claimed or attempted; there was nothing to validate.

## Findings recorded

- **Inventory:** voice-agent's tools are reclassified as business-scoped (see the inventory's "Other agents" section).
- **Backlog:**
  - §7 is closed as not applicable.
  - Business-owner delegation and Personal OS by phone are moved to "Deferred, or needs a decision" with their prerequisites.
- **The voice-agent `invocations` ledger stays voice-agent's evidence of record.** This is unchanged from the inventory's note on per-call ledgers.

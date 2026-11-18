# Verified identity linking (slice 5)

**Question this answers:** which Personal OS person is an external surface account acting for? It is answered separately from AuthBoundry's question, what an agent may do for that person. Nothing here grants authority.

**Result.** Personal OS already had a complete, two-sided linking lifecycle. It is backed by Resolver, built for the AnywhereAide surfaces (PO-35 in the [Personal OS inventory](capability-inventory/personalos.md)). This slice:

- verified it against the 22 acceptance criteria;
- found and fixed one real defect: two owners confirming the same account at once could both own it;
- tested the gaps: the authorization boundary, restart, revocation before Resolver hears of it, links that predate the fix, and audit;
- ran 14 mutations against the boundaries.

No new store, service, broker or identity provider was added.

| Repository                                            | Branch                         | Change                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rkendel1/personalOS` (from `1eb8c35`, now `340045a`) | `claude/dreamy-galileo-4z03p5` | Ownership claim (`feltkit/app.ts`, `feltkit/links.ts`); `tests/identity-linking.test.ts`; a Resolver `restart()` in `tests/fixtures/anywhere.ts` |
| `rkendel1/eve2`                                       | `claude/dreamy-galileo-4z03p5` | This report, inventory and backlog                                                                                                               |
| `rkendel1/feltkit`                                    | unchanged                      | —                                                                                                                                                |

eve's `examples/appport-agent` is unchanged. It acts for a person through FeltKit's delegated `/appport` (slice 2.0), where the person is named and AuthBoundry proves the delegation. Mapping a surface sender to that person is slice 6.

## Existing identity architecture (inspected)

| Concern                                   | Authority                                                                                                                                                      | Where                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who a person is                           | Personal OS (FeltKit accounts and sessions)                                                                                                                    | `auth: { accounts: { roles: ["owner"] } }`; password sign-in (web, iOS), sessions (Chrome)                                                                                             |
| Who an external surface account is        | The surface's authenticated delivery                                                                                                                           | Multiplayer and other bridges: an operator-issued `bridge` session, whose id must equal `envelope.source.adapter`. X: the post author id from X's API, read with the bot's OAuth token |
| Which person an external account acts for | **Resolver** (`@appport/resolver`)                                                                                                                             | `feltkit/_resolver.ts`: one reference per link; `identityLinks` is the owner's index, not an authority                                                                                 |
| What may be done for that person          | **AuthBoundry**                                                                                                                                                | `ctx.authority.decide({ capability, onBehalfOf })`, grants set only by the person (`delegation.ts`)                                                                                    |
| Audit                                     | FeltKit audit trail (one record per committed mutation: function, principal, writes, never values) and Resolver revision history (action, actor, reason, time) | `runtime/audit.ts`; `resolver.history`                                                                                                                                                 |

### Canonical identity and its representation

The canonical person is a Personal OS account id, written as `personalos:account:<owner>`. A link is one Resolver reference:

```
ref://identity/personalos/<adapter>/<sha256(instance)>/<sha256(principalId)>/<challengeId>
  → { canonical: "personalos:account:<owner>",
      external: { adapter, instance, principalId },
      verification: { method: "personalos.link-code/dm+owner-confirmed", challengeId, verifiedAt },
      linkedAt }
```

**Stable identifiers.** The external key is `(adapter, instance, principalId)`:

| Part          | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `adapter`     | the authenticated bridge or adapter                                                       |
| `instance`    | the surface installation (for X, the fixed `X_INSTANCE`)                                  |
| `principalId` | the surface's stable account id: a Multiplayer source principal, or X's numeric author id |

**Never identity:** handles, display names, e-mail addresses and `sender.claimed` assertions. Matching is exact; names and case variants never match.

**Resolution.** It uses one indexed `resolver.lookup`, and requires exactly one active reference whose stored `external` equals the sender. None gives `NOT_LINKED`; more than one gives `AMBIGUOUS_IDENTITY`. Both fail closed.

## Verification: proof of both sides

1. **The person.** A signed-in owner calls `links:start` (permission `links.write`, held only by the `owner` role). The result is a one-time code.
   - The code is 8 symbols over a 32-symbol alphabet: 40 bits drawn uniformly from `ctx.crypto.token`.
   - Only its SHA-256 digest is stored.
   - It expires in 10 minutes, is bound to that owner and to one adapter, and replaces any earlier pending code for that adapter.
2. **The external account.** The surface delivers `link XXXX-XXXX` with the sender's authenticated identity.
   - Multiplayer accepts it only in a direct message. In a shared conversation it is refused and burned.
   - On X, it is a mention, which is public. That is safe because a code is used up by its first presentation, and the owner must still confirm.
   - Presentation erases the digest and records which account presented it.
3. **The owner confirms that account** in Personal OS (`links:confirm`), within 30 minutes. A code someone else saw and sent first shows _their_ account, which the owner does not confirm.
4. **The `identity` agent** writes the link to Resolver. It runs as its own principal, with the only role that holds `identity.link`; no session holds it. It writes what the owner's record says, never what a request asks. Its Resolver key can only create (`expectedRevision: 0`) and revoke, and cannot read.

## The defect found, and the fix

**Defect.** Two owners each had a code presented by the same not-yet-linked account. If both confirmed at about the same time, **both links became `active`**, and Resolver held two references for one account. That account then resolved as ambiguous and failed closed for both owners.

- **Cause:** the identity agent's check ("is this account already linked to someone else?") and its Resolver write are not atomic, and FeltKit dispatches after-commit agent runs concurrently.
- **Reproduced:** in the first round of test 12, before the fix.

**Fix.** `identityLinks.claim` is the external identity's exact Resolver lookup entry. It has a **sparse unique constraint**, which FeltDB enforces at commit.

- `links:confirm` takes the claim in the owner's own transaction, and refuses with a clear reason when it is held:
  - "already connected to your PersonalOS account";
  - "already connected, or being connected, to a different PersonalOS account".
- The claim is released when the identity agent refuses, and when the link is finally revoked.
- The agent's Resolver check stays. It guards links that predate the claim.

## Lifecycle and states

```
pending ─(presented by the surface account)─▶ presented ─(owner confirms; claim taken)─▶ confirming
   │                                              │                                          │
   └──── revoke / expiry ──▶ revoked              └── revoke ──▶ revoked                      ├─(agent: recorded in Resolver)─▶ active ─(revoke)─▶ revoking ─(agent: revoked in Resolver; claim released)─▶ revoked
                                                                                              └─(agent: refuses; claim released)─▶ presented (with error)
```

**Revocation** takes effect at the owner's `links:revoke`, before Resolver is told. A `revoking` link is refused by intake (`NOT_LINKED`) whatever Resolver still says. In-flight interactions report `revoked`, and reminders stop. Resolver never reuses a revoked name, so relinking is a new reference, and the history (`create`, `revoke`, "disconnected by <owner>") stays.

**Unlinking** patches only the link record. It deletes no person, grant or other record.

## Identity is not authority (security boundaries)

- **A link grants nothing.** Linking and unlinking leave every AuthBoundry grant byte-for-byte unchanged: both people, the PersonalOS executor and an outside agent, asserted with the real local AuthBoundry.
- **Requests stay under the person's own grants.** A linked account's request is decided by AuthBoundry on behalf of its person. It is refused where that person granted nothing, or granted only reading.
- **No agent can link.**
  - The `agent` role holds nothing.
  - `links.*` is not delegable (`AGENT_CAPABILITIES`), so `delegation:set` refuses it.
  - FeltKit's delegated `/appport` refuses `links.start`, `links.confirm` and `links.revoke` for an agent, even one holding real grants.
  - A bridge cannot start, confirm or revoke.
  - The model's tools do not include linking.

## Acceptance tests

Personal OS, `npx feltkit test tests/identity-linking.test.ts` (new, **13/13**). It uses the real FeltKit runtime, the **real Resolver server** (a separate process, restarted in test 21) and the **real local AuthBoundry**; there is no stub authority. Existing coverage is in `tests/interactions.test.ts` (37) and `tests/x.test.ts` (14).

| #   | Criterion                                                     | Test                                                                                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | An authenticated person can initiate                          | identity-linking 1-3 (anonymous: `UNAUTHORIZED`; viewer: `FORBIDDEN`)                                        |
| 2   | An unverified external identity cannot be linked              | 1-3 (confirm with nothing presented: refused; presented but unconfirmed: `NOT_LINKED`, nothing in Resolver)  |
| 3   | A verified identity links to the correct person               | 1-3 (the Resolver value: canonical, external, verification method)                                           |
| 4   | Matching e-mails alone do not establish identity              | 4-5 (claimed e-mail and `verified_email` from another account: `NOT_LINKED`)                                 |
| 5   | Matching usernames or handles alone do not establish identity | 4-5; interactions "forged identity…"; x 8-9                                                                  |
| 6   | A model or agent cannot assert an identity                    | 6 (agent session, delegation, delegated `/appport`, bridge)                                                  |
| 7   | A challenge cannot be reused                                  | 7-10; interactions "linking: a code issued…"                                                                 |
| 8   | An expired challenge is rejected                              | 7-10 (code past 10 min); interactions "an expired presentation cannot be confirmed"                          |
| 9   | Another person cannot complete it                             | 7-10 (`NOT_FOUND` to confirm or revoke, not listed); interactions "only the owner who issued a code…"        |
| 10  | A challenge for one provider cannot be used for another       | 7-10 (an X code via Multiplayer; a Multiplayer code via another bridge; neither uses it up)                  |
| 11  | One external identity cannot be linked to two people          | 11, 13; x 8-9 (a code posted from an account linked elsewhere is refused and burnt)                          |
| 12  | Concurrent linking attempts preserve uniqueness               | 12 (three rounds, two owners confirming at once: exactly one active, one Resolver reference, not ambiguous)  |
| 13  | An already-linked identity cannot be silently transferred     | 11, 13; "a link recorded before ownership claims existed…"                                                   |
| 14  | A person can inspect their linked identities                  | 14-17                                                                                                        |
| 15  | A person can unlink                                           | 14-17                                                                                                        |
| 16  | An unlinked identity cannot be used afterwards                | 14-17; "revocation holds before Resolver hears of it"; interactions "revoked link…"                          |
| 17  | Unlinking preserves audit evidence                            | 14-17 (Resolver history `create`, `revoke`, "disconnected by ada"); audit test                               |
| 18  | No AuthBoundry grant created or modified                      | 18-20 (grant listings for both people and an outside agent identical before, after linking, after unlinking) |
| 19  | No Personal OS capability granted                             | 18-20 (a linked account with no grant, or read-only, cannot create)                                          |
| 20  | Direct-person authentication unchanged                        | 18-20 (Ada's own session before and after)                                                                   |
| 21  | Restart preserves links and revocations                       | 21 (Personal OS and the Resolver server both restarted)                                                      |
| 22  | Failed attempts leave no partial records                      | 22 (refused presentations change nothing; a refused confirmation leaves no reference and holds no claim)     |

**Audit test.** `links:start`, `interactions:receive` (the presentation and a refused attempt, each with its own record), `links:confirm` and `links:revoke` are each recorded with their actor, and the identity agent's writes are recorded as its own. No code and no code digest appears in any audit record or in Resolver's history.

**Suites:**

- Personal OS full suite (`npx feltkit test`): **166/166**, none skipped.
- eve's Personal OS end-to-end suite (`test/personalos.test.mjs`, real eve against a Personal OS process): **26/26**, with no AuthBoundry processes left behind.

## Mutation checks

Each boundary is removed in turn, and `identity-linking.test.ts` plus `interactions.test.ts` are run.

| Mutation                                                    | Caught by                                                                                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim check and unique constraint both removed              | 11/13; 12 (concurrent)                                                                                                                                                                                   |
| Claim check removed (constraint kept)                       | 11/13; 22                                                                                                                                                                                                |
| Unique constraint removed (claim check kept)                | **survives**: FeltDB's read fence on the claim lookup already makes the second concurrent confirmation conflict. The constraint is the storage-level guarantee, independent of how the lookup is written |
| Confirm does not check the owner                            | 7-10; interactions "only the owner…"                                                                                                                                                                     |
| Confirm without a presented account                         | 1-3                                                                                                                                                                                                      |
| A used code accepted again (status check removed)           | **survives**: presentation also erases the code's digest, so a used code is not found at all. Two independent gates                                                                                      |
| Expired code accepted                                       | 7-10                                                                                                                                                                                                     |
| Code accepted from another surface                          | 7-10                                                                                                                                                                                                     |
| Presentation of a linked account by another person accepted | 11/13; 22                                                                                                                                                                                                |
| Identity agent's different-owner check removed              | "a link recorded before ownership claims existed…"                                                                                                                                                       |
| A disconnecting (`revoking`) link still used                | "revocation holds before Resolver hears of it"                                                                                                                                                           |
| Outside agents' role given `links.*`                        | 6                                                                                                                                                                                                        |
| Linking made delegable to an agent                          | 6                                                                                                                                                                                                        |
| Code accepted in a shared conversation                      | interactions "a code posted in a shared conversation…"                                                                                                                                                   |

**12 of 14 are caught.** The two survivors are each covered by a second, independent gate, named above.

The first run had four survivors. Two of them, the agent check and the `revoking` refusal, showed tests that could not tell. The two new tests above were written for them, and both mutations now fail.

## Surfaces

| Surface                                           | Stable identifier                                                                                                                                                        | Verification                                                                                                          | Lifecycle                                                                                         | Implemented                                                  | Remaining                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X** (`@anywhereaide` bot)                       | X numeric user id of the mention's author, as X's API reports it (`authorId`), adapter `x`                                                                               | The author posts the one-time code in a mention, which only that account can do; the owner confirms the account shown | Start (`adapter: "x"`), mention, confirm, revoke; X intake refuses unlinked authors with no reply | Yes, in Personal OS (`xsurface.ts` receive)                  | **Not verified against real X**: tested against `tests/fixtures/x-api.ts`, a labelled local stand-in. Real X needs the bot's X API credential (operational) |
| **Multiplayer** (the bridge surfaces, Slack-like) | `(bridge id, installation, source principal id)` from the bridge's authenticated delivery                                                                                | DM-only code, then owner confirmation                                                                                 | As above                                                                                          | Yes, in Personal OS (`interactions.ts`)                      | The Multiplayer side is tested in its own repository                                                                                                        |
| **Chrome extension**                              | None external: it signs in **as the person** (FeltKit session: password or operator-issued; the extension has a stable ID for provider sign-in through FeltKit's broker) | Personal OS authentication itself                                                                                     | Sign in / sign out (7-day sessions)                                                               | N/A: nothing to link, it _is_ the canonical person's session | Nothing needed for slice 6 identity. Limitations in Personal OS `docs/LIMITATIONS.md`                                                                       |
| **iOS share extension**                           | None external: e-mail and password sign-in to Personal OS; bearer session in the Keychain                                                                                | Personal OS authentication itself                                                                                     | Sign in / sign out                                                                                | N/A, as for Chrome                                           | As for Chrome                                                                                                                                               |

No coverage is claimed for real X or for the Multiplayer side, beyond what their stand-in and their own repository test.

## Real vs stand-ins

| Real                                                                                                                                                                           | Stand-in                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| FeltKit runtime and FeltDB (unique constraint, transactions, audit); the Resolver server process and its store; `@authboundry/local`; FeltKit's delegated `/appport` over HTTP | The X API (`tests/fixtures/x-api.ts`, labelled "NOT X"); the Multiplayer bridge is an in-process bridge session; the dev users |

## Limitations and deferred findings

- **Claims start with this change.** Links made before it hold no claim. They are still protected: intake refuses a presentation of a linked account (`ALREADY_LINKED`), and the identity agent refuses a confirmation Resolver shows as someone else's (tested). Concurrent first-time confirmations are protected only from this change on. A backfill migration is not written.
- **One confirmation at a time per external account.** While one owner's confirmation is being recorded, another owner's confirmation of the same account is refused ("being connected"), even if the first then fails. The second owner retries.
- **FeltKit provider sign-in joins by provider-verified e-mail.** `accounts.signInWithProvider` attaches a GitHub or Google identity to the account with that e-mail. That is the person's authentication, not surface linking, and Personal OS does not enable `auth.providers` today. It is recorded, not changed: changing account semantics is out of scope.
- **Code entropy is 40 bits.** It is bounded by: delivery only through authenticated bridges, the 10-minute expiry, single use, and owner confirmation.
- **The model is not involved.** There is no model path to linking, so none is tested beyond the agent, delegation, bridge and `/appport` boundaries.
- **Slice 6 decides how an eve agent gets the resolved person** for a surface message. Resolution stays in Personal OS (Resolver keys are in FeltKit custody); eve must not resolve identity itself.

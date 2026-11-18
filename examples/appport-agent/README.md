# AppPort agent example

A minimal, self-hosted eve agent that acts for an authenticated person through one AppPort capability, under that person's AuthBoundry delegation. It needs no Vercel account or service.

- **Model.** `anthropic("claude-sonnet-5")` direct (`ANTHROPIC_API_KEY`), overridable with `APPPORT_AGENT_MODEL`.
- **Tools.** `defaultTools: false`. The agent has only `appport_capabilities`, `appport_contract`, and `appport_invoke`.
- **Route auth.** `jwtHmac` (HS256; `AGENT_JWT_SECRET`, `AGENT_JWT_ISSUER`, `AGENT_JWT_AUDIENCE`), then `placeholderAuth()`.
- **Persistence.** eve's local Workflow world in `.eve/.workflow-data` (SQLite). Sessions continue after a restart.

## How a capability call is authorized

Authentication, delegation and capability authorization are separate steps, each with its own owner.

1. **The person.** eve verifies the caller's JWT. The verified principal, for example `appport-agent-operator:alice`, becomes `ctx.session.auth.current`. The model never supplies it.
2. **The agent.** The tool calls AppPort with `@appport/client` at `APPPORT_URL` (`…/appport`). It sends the agent's AuthBoundry credential as `Authorization: Bearer` and the person as `x-appport-on-behalf-of`.
3. **Authentication at AppPort.** The host's `authenticate` hook accepts the request only when the credential equals the one the application holds for `agent:appport-agent`. That proves which agent is calling and grants nothing.
4. **Delegation.** The host's AppPort `Authorizer` asks AuthBoundry for each permission the capability declares:
   - it uses `POST /_authboundry/authorize/check` with the agent's credential and `on_behalf_of`;
   - it allows only on `allow`, which comes with the person's `delegation_id`;
   - any other answer is `FORBIDDEN` (`delegation_missing`, `delegation_revoked`, `delegation_expired`, and so on);
   - if AuthBoundry is unreachable the call fails closed (`INTERNAL_ERROR`).
5. **Exposure.** Only `effect: "observation"` capabilities listed in `APPPORT_AGENT_CAPABILITIES` are ever sent.
6. **Provenance** goes to `APPPORT_PROVENANCE_FILE`, joined by `requestId`:
   - `authorization`: agent, person, decision, `decisionId`, `delegationId`, reason;
   - `execution`: written by the handler, only when it ran;
   - `request`: AppPort's own telemetry.

## Who owns what

| Concern                                      | Owner                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| AuthBoundry server process and its state     | The AppPort application (`appport-host/host.mjs`), via `@authboundry/local`   |
| Grants and revocations                       | AuthBoundry, through the application (`authority.grant` / `authority.revoke`) |
| The agent's credential (issue, renew, store) | The application, written to `APPPORT_AGENT_CREDENTIAL_FILE` (mode 0600)       |
| Reading the current credential               | eve, from the same file, on every call                                        |

The agent never sends AuthBoundry a credential of its own. A renewed credential supersedes the old one, and replaying a superseded credential revokes the whole family (verified). So the application keeps custody and compares what the agent presents with its current copy.

## Run it

```bash
pnpm install
AUTHBOUNDRY_ADMIN_SECRET=<32+ chars> APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_PORT=4317 pnpm appport-host
EVE_MODEL_CATALOG=bundled pnpm build
ANTHROPIC_API_KEY=… AGENT_JWT_SECRET=<32+ chars> APPPORT_URL=http://127.0.0.1:4317/appport \
  APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_AGENT_CAPABILITIES=catalog.lookup pnpm start
```

The host keeps AuthBoundry's state and its check credential in `APPPORT_HOST_DATA_DIR` (default `.appport-host`).

Run the host under a supervisor that stops its whole process group (for example systemd's default `KillMode=control-group`). If the host is killed abruptly, the AuthBoundry server it started keeps running.

People grant through the application. This example has no person-facing grant screen; the tests grant and revoke with `host.authority`.

## Tests

`pnpm test` runs `node --test`.

**Always**, with real AppPort and AuthBoundry servers and no model:

- discovery and the capability's contract;
- no grant → `delegation_missing`;
- Alice's grant → a result equal to `catalog.json`, with the delegation in provenance;
- Bob can't use Alice's grant;
- invalid input is rejected;
- revocation stops the next call, and a new grant gets a new id;
- an expired grant is rejected;
- a forged agent credential gets `UNAUTHORIZED`;
- an AuthBoundry outage fails closed, then calls recover after the automatic restart;
- an AppPort outage is a failure, never a result;
- unexposed capabilities are never sent;
- grants and credentials survive a restart of the application.

Every rejected call is checked to have no `execution` record.

**With `APPPORT_AGENT_E2E_ANTHROPIC_API_KEY`**, the built agent on `eve start` with a real model:

- an unauthenticated request gets 401;
- Alice's answer comes through her delegation;
- the same session continues after a kill and restart;
- Bob is rejected.

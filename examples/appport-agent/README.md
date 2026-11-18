# AppPort agent example

A minimal, self-hosted eve agent whose only capability is reached through AppPort. It needs no
Vercel account or service.

- **Model.** `anthropic("claude-sonnet-5")` direct (`ANTHROPIC_API_KEY`), overridable with `APPPORT_AGENT_MODEL`.
- **Tools.** `defaultTools: false`, so no bash, file, or web tools. The agent has only `appport_capabilities`, `appport_contract`, and `appport_invoke`.
- **Route auth.** `jwtHmac` (HS256; `AGENT_JWT_SECRET`, `AGENT_JWT_ISSUER`, `AGENT_JWT_AUDIENCE`), then `placeholderAuth()`.
- **Persistence.** eve's local Workflow world in `.eve/.workflow-data` (SQLite). Sessions continue after a restart.

## How a capability call works

1. eve verifies the caller's JWT. The caller becomes `ctx.session.auth.current`, for example `appport-agent-operator:alice`.
2. The tool calls AppPort through `@appport/client` and its HTTP transport at `APPPORT_URL`, the full endpoint, for example `http://127.0.0.1:4317/appport`.
   - It sends a 60-second HS256 assertion (`APPPORT_AGENT_ASSERTION_SECRET`) naming that caller as `sub` and the agent as `act`.
3. The AppPort host's `authenticate` hook verifies the assertion and returns the principal.
4. AppPort's `permissionAuthorizer` decides. AppPort itself does not authenticate.
5. The agent invokes only capabilities that declare `effect: "observation"` and appear in `APPPORT_AGENT_CAPABILITIES`. Anything else is refused before any request is sent.
6. AppPort's telemetry sink records every request, including rejections and manifest reads, in `APPPORT_PROVENANCE_FILE`. Each record holds `requestId`, `traceId`, `principal`, `sessionId`, `capability`, `success`, and `errorCode`.

## Run it

```bash
pnpm install
APPPORT_AGENT_ASSERTION_SECRET=<32+ chars> APPPORT_PORT=4317 pnpm appport-host
EVE_MODEL_CATALOG=bundled pnpm build
ANTHROPIC_API_KEY=… AGENT_JWT_SECRET=<32+ chars> APPPORT_URL=http://127.0.0.1:4317/appport \
  APPPORT_AGENT_ASSERTION_SECRET=<same> APPPORT_AGENT_CAPABILITIES=catalog.lookup pnpm start
```

`appport-host/` is a test AppPort application. It has one read-only capability, `catalog.lookup`, which requires `catalog.read`, with permissions keyed by eve principal id in `principals.json`. Point `APPPORT_URL` at a real AppPort deployment instead, and give that deployment the same `authenticate` contract.

## Tests

`pnpm test` runs `node --test`:

- **Always.** Real AppPort over HTTP, with no model: discovery, contract, authorized call (checked against `catalog.json`), `FORBIDDEN`, forged assertion → `UNAUTHORIZED`, `INVALID_INPUT`, unexposed capability, and provenance records.
- **With `APPPORT_AGENT_E2E_ANTHROPIC_API_KEY`.** The built agent on `eve start` with a real model:
  - an unauthenticated request gets 401;
  - Alice's answer comes from AppPort;
  - the same session continues after a kill and restart;
  - Bob is rejected by AppPort.

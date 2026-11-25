# Gate: FeltKit produces, AppBoundry runs, AppPort reaches

The first gate of the Eve2-on-AppBoundry experiment. Before building the integration agent, it proves that the real
producer can emit an artifact that discovers and invokes another application's capability, and that the host runs it
with no companion process and no credential in the application.

| Gate | What it shows | How |
|---|---|---|
| 1. Bridge | `ctx.capabilities.list/invoke` in FeltKit's AppBoundry guest, mapped to `capability.list/invoke` | `rkendel1/feltkit` `packages/sdk/test/capabilities-appboundry.test.ts` |
| 2. Producer | `feltkit build --target appboundry` builds `app/` into `ledgerbridge.app` | the real CLI, below |
| 3. Artifact | `appboundry.app/1` from producer `feltkit`; requires `capabilities@1`; `requires` lists both capabilities; `module.wasm` imports nothing; `network: "none"`; no components | `appboundry artifact verify / inspect` |
| 4. Host | `appboundry run` (own process) invokes `provider/books.mjs` (own process, own credential) over AppPort | `run-gate.mjs`, evidence in `evidence/gate-run.json` |

## Run it

Needs sibling checkouts of `rkendel1/feltkit` and `rkendel1/appboundry` on `claude/trusting-faraday-j5o0md`, both
built, and Node 26 for FeltKit's CLI (the host runs on Node 22+).

```bash
cd app && npm install && npx feltkit build --target appboundry && cd ..
```

```bash
cd provider && npm install && cd ..
```

```bash
node run-gate.mjs
```

## Result (2026-11-25): PASS

- **Discovery is not authority.** `books.invoices.create` was listed as `granted`; `books.invoices.void` as `offered`
  (bound, no grant). Invoking `void` was `refused NOT_GRANTED` before anything was sent.
- **Invocation.** `create` succeeded through AppPort, and the provider's own state shows the invoice.
  The same key again was replayed from the host's ledger without sending.
- **Credentials.** The provider refused a caller without its credential (HTTP 401). The credential lives only in
  the host process's environment, named by the operator's bindings file.
- **Timeout after effect.** The provider committed and answered after the 1.5 s binding timeout. The outcome was
  recorded as `unknown`, not `failed`. A resend with the same key succeeded as attempt 2, and the provider still
  holds exactly two invoices.
- **Durable evidence.** After the host stopped, `appboundry admin export` of its state contains both
  `_appboundry_outbound` records: grant, initiator, input digest, and every attempt with its outcome and timing. The
  application's own `attempts` collection holds what the code observed, including the `unknown`.
- **No companion.** Two processes ran: the host and the provider. The artifact declares no components.

The provider here is a minimal AppPort application written for the gate, not a real finance system. The real
systems come in the Eve2 scenario.

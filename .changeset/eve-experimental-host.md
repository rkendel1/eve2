---
"eve": minor
---

Add `eve/experimental/host`, which runs an agent's complete session runtime on any JavaScript host that supplies model calls, network, timers and async context, such as a Wasm guest.

`createEveHost({ agent, models })` takes the compiled agent and an optional model resolver that owns every model choice and provider call; `connect({ application, conversation })` returns the address an application delivers messages and approval answers to. Sessions live in the host's instance: they do not survive it, and there is no resumption yet. eve's modules now load without Node and import hosting code (Workflow, sandbox, model auth, Vercel OIDC) on first use, so behaviour on Node is unchanged.

---
"eve": minor
---

Run a whole `agents/` workspace without Vercel: `eve build` at the workspace root builds every agent for Node, and `eve start` serves them together with working peer calls.

- `eve start` at a workspace root, without `--agent`, starts every agent and serves each at `/eve/<name>/v1/*` from one origin. `/eve/v1/health` reports each agent, and a stopped agent's routes answer 503.
- `defineWorkspaceAgent()` peers work without an explicit transport under `eve start`. Calls carry a short-lived token signed with the workspace secret, `EVE_WORKSPACE_SECRET` or a per-start random one.
- `workspacePeers()` from `eve/experimental/workspace` admits those calls. The caller becomes the service principal `eve-workspace:<agent>` and gains no user's authority unless `trustedForwarders` accepts a forwarded principal. The default `agent/channels/eve.ts` policy includes it.
- `EVE_CALLBACK_ALLOWED_ORIGINS` lists exact origins that may receive remote-agent callbacks on loopback addresses. `eve start` sets it for workspace agents; private network ranges stay blocked.

---
"eve": patch
---

`eve start` now reports whether the build's sandbox is usable, and `placeholderAuth()` explains unconfigured auth on self-hosted servers.

- `eve start` prints a `sandbox:` line before serving: the provider the build recorded, and for Docker whether the daemon is reachable and has the build's template image.
- `placeholderAuth()` now returns its `eve_production_auth_not_configured` 401, with a `Bearer` challenge, on self-hosted production servers as well as Vercel production. Requests were already rejected; the response now names the fix.
- `eve init` without a TTY prints the selected model and whether it routes through AI Gateway or calls a provider directly.
- A workspace root `eve build` outside Vercel explains that it wrote Vercel Build Output and how to build members for self-hosting.

---
"eve": patch
---

`eve init`, `eve add`, and `eve extension init` run from a scoped eve distribution such as `@appport/eve` now install that distribution as `"eve": "npm:@appport/eve@^<version>"` instead of the unrelated `eve` package.

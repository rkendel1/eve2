---
"eve": patch
---

`eve dev` now uses `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the environment, as `eve start` does, when `/login` had chosen a saved key that the machine no longer has or whose OS secret store can't be read.

---
"eve": minor
---

`eve build` no longer needs the AI Gateway model catalog: it falls back to model metadata bundled with eve, and `EVE_MODEL_CATALOG=bundled` skips the request entirely.

A direct `anthropic()` or `openai()` model, and any model the bundled metadata lists, compiles offline. A build that fell back warns with `compile/model-metadata-bundled`. A model the bundled metadata doesn't list still needs `modelContextWindowTokens`.

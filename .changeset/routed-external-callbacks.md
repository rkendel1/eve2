---
"eve": patch
---

Connection and remote-agent callbacks now reach a session through whichever execution host runs it, instead of asking Workflow directly.

On Workflow the behavior is unchanged. When no host holds the callback's session, it is answered as not pending without loading Workflow. The in-process host's refusal of cross-session operations now names the missing capability instead of telling you to deploy.

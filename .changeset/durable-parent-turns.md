---
"eve": patch
---

On an in-process host with a durable store, a parent turn interrupted by a restart now continues where it stopped, and its child agents are dispatched at most once.

The parent records its continuation before each step and its dispatch intent before any child run starts. A child's record and first checkpoint are written together, and the child acknowledges itself on the parent before it runs. A restore re-attaches to an existing child, relaunches only a child that provably never ran, and otherwise fails the call explicitly. A restored task wait keeps results applied after the last checkpoint. A session with an unreadable continuation is refused together with its children. A task whose authored run died ends with an explicit unknown outcome instead of running again. Workflow behavior is unchanged.

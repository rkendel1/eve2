---
"eve": minor
---

Added the work channel, `workChannel` from `eve/channels/work`, and its Node.js 22-compatible client, `createWorkClient` from `eve/channels/work/client`, to run an agent as a worker that services submit idempotent work to, steer, interrupt, stop, follow from a durable cursor, and read structured results from.

Each piece of work is one session owned by its submitter. Status and results declare which controls the runtime performs (`pause` and `resume` are reported as unsupported) and identify the attempt and runner. Work can name a repository on an allowlisted host, which eve checks out in the sandbox before the first model call, and `onResult` receives the workspace's branch, commit, and changed files after each attempt.

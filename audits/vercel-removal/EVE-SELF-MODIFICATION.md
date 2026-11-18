# Deployed self-modification: what exists, and the missing contract

**Status: not implemented in this slice.** No stub was added. This document records why, and the concrete next step.

## What eve calls "deployed self-modification" today (verified in code)

It is a **proposal workflow**, not a deployment system:

1. A subagent opens a sandbox and checks out a GitHub repository at a target branch (`self-modification/git-workspace.ts`).
2. It edits files under `/source`. Protected paths are refused: `.git`, `.env*`, `node_modules`, `.vercel`, `.github/workflows/`. Limits: 100 files and 1 MB (`proposal.ts`).
3. `publish` creates blobs, a tree and a commit through the GitHub REST API, then a **draft pull request**. The receipt always reports `deployed: false`, `merged: false` (`github-publisher.ts`, `tools/publish.ts`).
4. Authorization: a required `authorize({ channel, principal })` that fails closed, plus a credential provider per capability (`checkout`, `publish`).

There is no activation, health verification, or rollback anywhere in eve, **including on Vercel**. Activation is a human merging the PR and a normal redeploy.

## The Vercel dependency, precisely

`deployed-sandbox.ts:32-35` requires Vercel Sandbox, because only its network policy supports **header transforms**. eve injects `Authorization: Basic x-access-token:<token>` for `github.com` at the network layer (`shared/git.ts:31-35`), so the GitHub token never enters the sandbox. The Docker provider supports only `allow-all` and `deny-all`, and rejects domain and transform policies (`docker.integration.test.ts:663-668`).

So the blocker is **credential brokering inside the sandbox**, not deployment.

## Why it was not implemented here

There are two separate gaps:

1. **Self-hosted parity for what exists:** the draft-PR workflow without Vercel Sandbox. This needs a sandbox egress proxy that injects the GitHub credential for an allowlisted host. Docker can do this with a sidecar or an HTTP proxy on the sandbox network. It is new sandbox infrastructure with real security weight: token isolation and egress control. It deserves its own design and tests, not a rushed addition.
2. **The lifecycle requested** (immutable artifact → validate → test → approve → activate → verify health → rollback). This exists on no platform in eve today. It is a new product capability, not a Vercel removal.

## Proposed contract (next step), compatible with a future AppBoundry adapter

```ts
interface ApplicationUpdateTarget {
  // Immutable, content-addressed artifact built from a proposal (e.g. `eve build` output tarball + digest).
  stage(artifact: { digest: string; path: string }): Promise<{ candidateId: string }>;
  activate(candidateId: string): Promise<{ activationId: string }>; // must keep the previous version
  health(activationId: string): Promise<"healthy" | "unhealthy">;
  rollback(activationId: string): Promise<void>; // reactivates the previous version
}
```

Lifecycle ownership:

| Step                         | Owner                             |
| ---------------------------- | --------------------------------- |
| Proposal                     | Existing draft-PR flow            |
| Build                        | `eve build` in CI                 |
| Approval                     | eve approvals (`always()`)        |
| Activation, health, rollback | The target                        |
| Evidence                     | A durable workflow run per update |

Possible targets:

| Target      | Approach                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Self-hosted | Swap a symlinked release directory, restart through the process manager, probe `/eve/v1/health` |
| Vercel      | Deployments API with promote and instant rollback                                               |
| AppBoundry  | Its own adapter                                                                                 |

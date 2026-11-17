# Default model decision

## Problem

Plain non-interactive `eve init` writes `model: "openai/gpt-6-luna-fast"`, which routes through Vercel AI Gateway. A non-agent run printed no model at all, so a user without a gateway credential found the dependency only when the first turn failed.

## How init actually behaves (verified)

| Path                                             | Behavior before this slice                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive TTY, no `--model`                    | Opens provider onboarding (Vercel account, ChatGPT, gateway key, OpenAI key, Anthropic key) before `eve dev`; the chosen provider rewrites `agent.ts`. Already an explicit choice |
| Non-interactive or coding agent, no `--model`    | Writes the gateway string. Coding agents saw `✓ Model … (eve default)` with no routing information; a plain `-n` run saw nothing                                                  |
| `--model anthropic-api/<id>` / `openai-api/<id>` | Direct helper (fixed in the previous slice)                                                                                                                                       |
| `--model <provider>/<id>`                        | Gateway string                                                                                                                                                                    |

## Alternatives

| #   | Option                                                                   | Consequence                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Keep the gateway default; make the dependency unmistakable               | Fully backward compatible. Coding agents and CI scripts running `eve init -n` keep a working project when they have a gateway key. Non-gateway users are told exactly how to switch  |
| 2   | Choose the provider from explicit init options                           | Already exists (`--model …-api/…`). Adds nothing on its own                                                                                                                          |
| 3   | Provider-neutral scaffold that requires a choice                         | Breaking. `eve init -n` would produce a project that cannot answer until edited, or would have to fail. Coding agents use this path heavily (`isCodingAgentLaunch` skips onboarding) |
| 4   | Interactive provider selection plus a deterministic non-interactive rule | The interactive half already exists. The non-interactive half reduces to option 1 or option 3                                                                                        |

Rejected outright, per the brief: choosing Anthropic or OpenAI because an API key happens to be in the environment. Credential presence is not intent, and that rule would make the scaffold depend on the shell it ran in.

## Decision

**Option 1, combined with the existing option 4 behavior.** It is the least surprising backward-compatible design, and it is reversible.

- Interactive init is unchanged and still forces an explicit provider choice.
- Every non-interactive path now prints the model **and how it is routed**, including the plain `-n` path that used to be silent:

  ```
  ✓ Model openai/gpt-6-luna-fast (eve default)
    Routes through Vercel AI Gateway with AI_GATEWAY_API_KEY or Vercel OIDC. To call a provider directly, run `eve set model anthropic-api/claude-sonnet-5` or `eve set model openai-api/gpt-6-luna-fast`.
  ```

  Direct scaffolds print `Calls Anthropic directly with ANTHROPIC_API_KEY.` or the OpenAI equivalent.

- The suggested command is real. Running `eve set model anthropic-api/claude-sonnet-5` on a fresh default scaffold produced `import { anthropic } from "eve/models/anthropic"` and `model: anthropic("claude-sonnet-5")`.

No comment is written into `agent.ts`. `/login` and `eve set model` rewrite only the model value, so a routing comment there would become stale and wrong after a switch.

### Product decision still open

Option 3 (stop defaulting to AI Gateway) is a compatibility change for upstream eve and its coding-agent flows. It needs an owner's call, and it can be layered on later without undoing this change.

## Implementation

- `cli/commands/agent-instructions.ts`: new `describeModelRouting(selection)` built on the shared `parseModelHelper`. `initAgentReadySummary` now includes it.
- `cli/commands/init.ts`: the non-interactive, non-agent path now prints the summary.

## Tests

`cli/commands/init.integration.test.ts`, describe block "init model routing", runs the real scaffold with only package install mocked:

| Case                            | Asserts                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain interactive               | Onboarding opens and `eve dev --onboarded` follows                                                                                                                                                  |
| Plain non-interactive           | Gateway string in `agent.ts`; output names AI Gateway, `AI_GATEWAY_API_KEY`, and the `eve set model anthropic-api/…` switch; no onboarding                                                          |
| `anthropic-api/claude-sonnet-5` | Helper import and call; no `model: "…"` string anywhere; dependencies exactly `@vercel/connect, ai, eve, zod`; output names `ANTHROPIC_API_KEY` and not AI Gateway; no `.vercel/`, no `vercel.json` |
| `openai-api/gpt-6-luna-fast`    | Same, for OpenAI                                                                                                                                                                                    |
| `anthropic/claude-sonnet-5`     | Stays a gateway string; output says it routes through AI Gateway                                                                                                                                    |

Unit tests cover `describeModelRouting` for all three helpers and for a gateway ID (`agent-instructions.test.ts`). The previous slice's template tests still pass.

The scaffold always adds `@vercel/connect` as a dependency. It is an npm package that needs no Vercel account and fails nothing; it is listed under remaining gaps.

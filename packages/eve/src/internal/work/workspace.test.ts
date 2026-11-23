import { describe, expect, it } from "vitest";

import type { SandboxCommandResult } from "#shared/sandbox-session.js";

import { prepareRepository, readWorkspace } from "./workspace.js";

const COMMIT = "a".repeat(40);
const BASE = "b".repeat(40);

function sandbox(answers: readonly [RegExp, SandboxCommandResult][]) {
  const commands: string[] = [];
  return {
    commands,
    resolvePath: (path: string) => (path === "." ? "/workspace" : `/workspace/${path}`),
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      const match = answers.find(([pattern]) => pattern.test(command));
      return match?.[1] ?? { exitCode: 127, stderr: "not found", stdout: "" };
    },
  };
}

describe("prepareRepository", () => {
  it("fetches the ref, checks out the work branch, and reports the base commit", async () => {
    const box = sandbox([[/git fetch/u, { exitCode: 0, stderr: "", stdout: `${BASE}\n` }]]);
    await expect(
      prepareRepository(box, {
        branch: "work/notes",
        ref: "main",
        url: "https://github.com/acme/app",
      }),
    ).resolves.toEqual({ baseCommit: BASE });
    const [script] = box.commands;
    expect(script).toContain("git fetch -q --depth 1 origin 'main'");
    expect(script).toContain("git checkout -q -B 'work/notes'");
    expect(script).toContain("'https://github.com/acme/app'");
  });

  it("reports a failed checkout without a commit", async () => {
    const box = sandbox([[/git fetch/u, { exitCode: 128, stderr: "denied", stdout: "" }]]);
    await expect(prepareRepository(box, { url: "https://github.com/acme/app" })).resolves.toEqual({
      error: "Could not check out https://github.com/acme/app (exit 128).",
    });
  });
});

describe("readWorkspace", () => {
  it("reports branch, commit, and files changed since the base commit", async () => {
    const box = sandbox([
      [/rev-parse --abbrev-ref/u, { exitCode: 0, stderr: "", stdout: `work/notes\n${COMMIT}\n` }],
      [/git status/u, { exitCode: 0, stderr: "", stdout: " M README.md\nR  a.md -> b.md\n" }],
      [/git diff --name-only/u, { exitCode: 0, stderr: "", stdout: "src/index.ts\nREADME.md\n" }],
    ]);
    const repository = { url: "https://github.com/acme/app" };
    await expect(readWorkspace(box, repository, BASE, null)).resolves.toEqual({
      error: null,
      git: {
        baseCommit: BASE,
        branch: "work/notes",
        changedFiles: ["README.md", "b.md", "src/index.ts"],
        commit: COMMIT,
        dirty: true,
      },
      repository,
      root: "/workspace",
    });
  });

  it("reports no git state outside a checkout", async () => {
    const box = sandbox([]);
    await expect(readWorkspace(box, null, null, "Could not check out.")).resolves.toEqual({
      error: "Could not check out.",
      git: null,
      repository: null,
      root: "/workspace",
    });
  });
});

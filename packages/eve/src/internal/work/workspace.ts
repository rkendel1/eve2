import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#shared/shell-quote.js";

import type { WorkRepository } from "./submission.js";

/** Git facts read from the work's sandbox when an attempt ends. `changedFiles` covers commits since `baseCommit` and uncommitted files. */
export interface WorkGitState {
  readonly branch: string | null;
  readonly commit: string | null;
  readonly baseCommit: string | null;
  readonly dirty: boolean;
  readonly changedFiles: readonly string[];
}

/** The work's sandbox workspace after an attempt; `error` reports a failed repository checkout. */
export interface WorkWorkspace {
  readonly root: string;
  readonly repository: WorkRepository | null;
  readonly git: WorkGitState | null;
  readonly error: string | null;
}

type Runner = Pick<SandboxSession, "run" | "resolvePath">;

const MAX_CHANGED_FILES = 500;

export async function prepareRepository(
  sandbox: Runner,
  repository: WorkRepository,
): Promise<{ readonly baseCommit: string } | { readonly error: string }> {
  const steps = [
    "set -e",
    "[ -d .git ] || git init -q",
    `git remote add origin ${shellQuote(repository.url)} 2>/dev/null || git remote set-url origin ${shellQuote(repository.url)}`,
    `git fetch -q --depth 1 origin ${shellQuote(repository.ref ?? "HEAD")}`,
    "git checkout -q --detach FETCH_HEAD",
    ...(repository.branch === undefined
      ? []
      : [`git checkout -q -B ${shellQuote(repository.branch)}`]),
    "git rev-parse HEAD",
  ];
  const result = await sandbox.run({ command: steps.join("\n") });
  const commit = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) {
    return {
      error: `Could not check out ${repository.url}${repository.ref === undefined ? "" : ` at ${repository.ref}`} (exit ${result.exitCode}).`,
    };
  }
  return { baseCommit: commit };
}

export async function readWorkspace(
  sandbox: Runner,
  repository: WorkRepository | null,
  baseCommit: string | null,
  error: string | null,
): Promise<WorkWorkspace> {
  const root = sandbox.resolvePath(".");
  return { error, git: await readGitState(sandbox, baseCommit), repository, root };
}

async function readGitState(
  sandbox: Runner,
  baseCommit: string | null,
): Promise<WorkGitState | null> {
  const head = await sandbox.run({
    command: "git rev-parse --abbrev-ref HEAD && git rev-parse HEAD",
  });
  if (head.exitCode !== 0) return null;
  const [branch, commit] = head.stdout.trim().split("\n");
  const status = await sandbox.run({ command: "git status --porcelain=v1 --untracked-files=all" });
  const working = status.exitCode === 0 ? porcelainPaths(status.stdout) : [];
  const committed =
    baseCommit === null
      ? []
      : await sandbox
          .run({ command: `git diff --name-only ${shellQuote(baseCommit)} HEAD` })
          .then((diff) => (diff.exitCode === 0 ? lines(diff.stdout) : []));
  return {
    baseCommit,
    branch: branch === undefined || branch === "HEAD" ? null : branch,
    changedFiles: [...new Set([...committed, ...working])].sort().slice(0, MAX_CHANGED_FILES),
    commit: commit !== undefined && /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null,
    dirty: working.length > 0,
  };
}

function lines(output: string): string[] {
  return output.split("\n").filter((line) => line.length > 0);
}

function porcelainPaths(output: string): string[] {
  return lines(output).map((line) => {
    const path = line.slice(3);
    const renamed = path.indexOf(" -> ");
    return renamed === -1 ? path : path.slice(renamed + 4);
  });
}

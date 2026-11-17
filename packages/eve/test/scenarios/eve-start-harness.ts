import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));

export function isVercelEnvName(name: string): boolean {
  return /^VERCEL/u.test(name) || name === "AI_GATEWAY_API_KEY";
}

export function withoutVercelEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (isVercelEnvName(name) || /_API_KEY$/u.test(name) || name.startsWith("EVE_ACCEPTANCE_")) {
      continue;
    }
    env[name] = value;
  }
  return {
    ...env,
    PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    NODE_ENV: "production" as const,
    EVE_MOCK_AUTHORED_MODELS: "",
    EVE_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

export interface RunningEveStart {
  readonly url: string;
  crash(): Promise<void>;
  stderr(): string;
  stdout(): string;
  stop(): Promise<void>;
}

export async function startPackagedEveStart(
  appRoot: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RunningEveStart> {
  const child = spawn(
    process.execPath,
    [EVE_BIN_PATH, "start", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      detached: true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForStartUrl({
      child,
      getOutput: () => ({
        stderr,
        stdout,
      }),
    });
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    async crash() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    },
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChildProcess(child, () => stderr);
    },
    url,
  };
}

async function waitForStartUrl(input: {
  readonly child: ChildProcess;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const output = input.getOutput();
    const url = parseStartUrl(output.stdout);

    if (url !== undefined) {
      return url;
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(
        [
          `eve start exited before printing its server URL (code ${String(
            input.child.exitCode,
          )}, signal ${String(input.child.signalCode)}).`,
          `stdout:\n${output.stdout}`,
          `stderr:\n${output.stderr}`,
        ].join("\n\n"),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const output = input.getOutput();
  throw new Error(
    [
      "Timed out waiting for eve start to print its server URL.",
      `stdout:\n${output.stdout}`,
      `stderr:\n${output.stderr}`,
    ].join("\n\n"),
  );
}

function parseStartUrl(output: string): string | undefined {
  const match = /\[START\] server listening at (https?:\/\/[^\s]+)/.exec(output);
  return match?.[1];
}

const STOP_TIMEOUT_MS = 10_000;

async function stopChildProcess(child: ChildProcess, readStderr?: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timer: NodeJS.Timeout | undefined;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (stopped) return;

  process.kill(-child.pid!, "SIGKILL");
  await exited;
  const message = `eve start did not exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM.\n\nstderr:\n${readStderr?.() ?? ""}`;
  if (expect.getState().currentTestName === undefined) throw new Error(message);
  expect.soft(stopped, message).toBe(true);
}

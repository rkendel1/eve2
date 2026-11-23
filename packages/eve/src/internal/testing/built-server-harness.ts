import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface RunningEveServer {
  readonly url: string;
  readonly output: () => string;
  stop(): Promise<void>;
}

type ServerEnv = Readonly<Record<string, string>>;

const LISTEN_TIMEOUT_MS = 120_000;

function runEve(appRoot: string, args: readonly string[], env: ServerEnv): ChildProcess {
  return spawn(process.execPath, [join(appRoot, "node_modules", "eve", "bin", "eve.js"), ...args], {
    cwd: appRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function buildEve(appRoot: string, env: ServerEnv = {}): Promise<void> {
  const build = runEve(appRoot, ["build"], env);
  let output = "";
  build.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  build.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => build.on("exit", resolve));
  if (code !== 0) throw new Error(`eve build failed:\n${output}`);
}

export async function startBuiltEve(
  appRoot: string,
  env: ServerEnv = {},
): Promise<RunningEveServer> {
  const child = runEve(appRoot, ["start", "--host", "127.0.0.1", "--port", "0"], env);
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`eve start did not listen:\n${output}`)),
      LISTEN_TIMEOUT_MS,
    );
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", () => reject(new Error(`eve start exited:\n${output}`)));
  });
  return {
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
    url,
  };
}

export async function buildAndStartEve(
  appRoot: string,
  env: ServerEnv = {},
): Promise<RunningEveServer> {
  await buildEve(appRoot, env);
  return await startBuiltEve(appRoot, env);
}

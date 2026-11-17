import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createDockerCli, type DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import {
  sandboxPreparedArtifactsManifestSchema,
  type SandboxPreparedArtifactEntry,
  type SandboxPreparedArtifactsManifest,
} from "#shared/sandbox-prepared-artifacts.js";

export interface SandboxReadinessLine {
  readonly message: string;
  readonly tone: "success" | "warning" | "info";
}

const ROOT_NODE_ID = "__root__";

export async function checkBuiltSandboxReadiness(
  appRoot: string,
  docker: DockerCli = createDockerCli(),
): Promise<SandboxReadinessLine[]> {
  const path = join(
    resolve(appRoot),
    ".output",
    ".eve",
    "compile",
    "sandbox-prepared-artifacts.json",
  );
  let manifest: SandboxPreparedArtifactsManifest;
  try {
    manifest = sandboxPreparedArtifactsManifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    return [];
  }
  return await assessSandboxReadiness(manifest, docker);
}

export async function assessSandboxReadiness(
  manifest: SandboxPreparedArtifactsManifest,
  docker: DockerCli,
): Promise<SandboxReadinessLine[]> {
  const lines: SandboxReadinessLine[] = [];
  for (const entry of manifest.entries) {
    const label = entry.nodeId === ROOT_NODE_ID ? "sandbox" : `sandbox (${entry.nodeId})`;
    const { message, tone } = await assessEntry(entry, docker);
    lines.push({ message: `${label}: ${message}`, tone });
  }
  return lines;
}

async function assessEntry(
  entry: SandboxPreparedArtifactEntry,
  docker: DockerCli,
): Promise<SandboxReadinessLine> {
  const selected = selectedProvider(entry);
  if (selected.provider === null) {
    return {
      tone: "warning",
      message:
        "none. This build recorded no sandbox provider, so tool calls that open the sandbox fail. " +
        "Run `eve build` where a Docker daemon is reachable, or select a provider in agent/sandbox/sandbox.ts.",
    };
  }
  if (selected.provider !== "docker" || selected.imageReference === undefined) {
    return { tone: "info", message: `${selected.provider} provider recorded by the build.` };
  }
  const daemon = await runDocker(docker, ["version", "--format", "{{.Server.Os}}"]);
  if (daemon === undefined || daemon.exitCode !== 0) {
    return {
      tone: "warning",
      message:
        "docker, but the Docker daemon is not reachable, so tool calls that open the sandbox fail. " +
        "Start Docker on this host, or point the docker CLI at it with DOCKER_HOST or EVE_DOCKER_PATH.",
    };
  }
  const image = await runDocker(docker, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    selected.imageReference,
  ]);
  if (image === undefined || image.exitCode !== 0) {
    return {
      tone: "warning",
      message:
        `docker, but template image ${selected.imageReference} is missing on this Docker daemon. ` +
        "eve prepares it during `eve build` and never recreates it at runtime. Run `eve build` against this daemon.",
    };
  }
  return { tone: "success", message: `docker template ${selected.imageReference} is ready.` };
}

function selectedProvider(entry: SandboxPreparedArtifactEntry): {
  readonly imageReference?: string;
  readonly provider: string | null;
} {
  const outer = asRecord(entry.artifact);
  const delegated = entry.providerName === "default" && outer !== undefined && "provider" in outer;
  const provider = delegated
    ? typeof outer.provider === "string"
      ? outer.provider
      : null
    : entry.providerName;
  const inner = asRecord(delegated ? outer.artifact : entry.artifact);
  const imageReference =
    typeof inner?.imageReference === "string" ? inner.imageReference : undefined;
  return { imageReference, provider };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function runDocker(docker: DockerCli, args: readonly string[]) {
  try {
    return await docker.run(args, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return undefined;
  }
}

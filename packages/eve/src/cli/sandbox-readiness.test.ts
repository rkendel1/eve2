import { describe, expect, it } from "vitest";

import type { DockerCli, DockerCommandResult } from "#execution/sandbox/bindings/docker-cli.js";
import {
  createSandboxPreparedArtifactsManifest,
  type SandboxPreparedArtifactEntry,
} from "#shared/sandbox-prepared-artifacts.js";

import { assessSandboxReadiness } from "./sandbox-readiness.js";

const IMAGE = "eve-sandbox-template:abc-123";

function fakeDocker(responses: {
  readonly daemon?: number | "missing-cli";
  readonly image?: number;
}): DockerCli & { readonly calls: string[][] } {
  const calls: string[][] = [];
  const result = (exitCode: number): DockerCommandResult => ({
    exitCode,
    stderr: "",
    stdout: exitCode === 0 ? "linux\n" : "",
    stdoutBytes: Buffer.alloc(0),
  });
  return {
    calls,
    async run(args) {
      calls.push([...args]);
      if (args[0] === "version") {
        if (responses.daemon === "missing-cli") throw new Error("spawn docker ENOENT");
        return result(responses.daemon ?? 0);
      }
      return result(responses.image ?? 0);
    },
    stream() {
      throw new Error("stream is not used by the readiness check");
    },
  };
}

function manifest(...entries: SandboxPreparedArtifactEntry[]) {
  return createSandboxPreparedArtifactsManifest(entries);
}

const defaultDocker: SandboxPreparedArtifactEntry = {
  artifact: { artifact: { imageReference: IMAGE }, provider: "docker" },
  nodeId: "__root__",
  providerName: "default",
};

describe("assessSandboxReadiness", () => {
  it("warns when the build recorded no provider, without calling Docker", async () => {
    const docker = fakeDocker({});
    const lines = await assessSandboxReadiness(
      manifest({ artifact: { provider: null }, nodeId: "__root__", providerName: "default" }),
      docker,
    );

    expect(lines).toEqual([
      expect.objectContaining({
        tone: "warning",
        message: expect.stringContaining("sandbox: none"),
      }),
    ]);
    expect(lines[0]?.message).toContain("Docker daemon is reachable");
    expect(docker.calls).toEqual([]);
  });

  it("reports a ready DefaultSandbox Docker template", async () => {
    const docker = fakeDocker({});
    await expect(assessSandboxReadiness(manifest(defaultDocker), docker)).resolves.toEqual([
      { tone: "success", message: `sandbox: docker template ${IMAGE} is ready.` },
    ]);
    expect(docker.calls.at(-1)).toEqual(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
  });

  it("reports an explicit DockerSandbox template", async () => {
    const lines = await assessSandboxReadiness(
      manifest({ artifact: { imageReference: IMAGE }, nodeId: "support", providerName: "docker" }),
      fakeDocker({}),
    );

    expect(lines).toEqual([
      { tone: "success", message: `sandbox (support): docker template ${IMAGE} is ready.` },
    ]);
  });

  it.each([
    ["the daemon is unreachable", { daemon: 1 }],
    ["the docker CLI is missing", { daemon: "missing-cli" as const }],
  ])("warns when %s at runtime", async (_name, responses) => {
    const [line] = await assessSandboxReadiness(manifest(defaultDocker), fakeDocker(responses));

    expect(line?.tone).toBe("warning");
    expect(line?.message).toContain("Docker daemon is not reachable");
    expect(line?.message).toContain("DOCKER_HOST");
  });

  it("warns when the template image is missing from the runtime daemon", async () => {
    const [line] = await assessSandboxReadiness(manifest(defaultDocker), fakeDocker({ image: 1 }));

    expect(line?.tone).toBe("warning");
    expect(line?.message).toContain(`template image ${IMAGE} is missing`);
    expect(line?.message).toContain("never recreates it at runtime");
  });

  it("names other recorded providers without probing Docker", async () => {
    const docker = fakeDocker({});
    const lines = await assessSandboxReadiness(
      manifest({
        artifact: { artifact: {}, provider: "vercel" },
        nodeId: "__root__",
        providerName: "default",
      }),
      docker,
    );

    expect(lines).toEqual([
      { tone: "info", message: "sandbox: vercel provider recorded by the build." },
    ]);
    expect(docker.calls).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { workspacePeers } from "#channel/auth/definitions.js";
import { defineWorkspaceAgent } from "#public/definitions/workspace-agent.js";

import {
  isAllowedCallbackOrigin,
  mintWorkspacePeerToken,
  readWorkspacePeers,
  readWorkspaceSecret,
} from "./peer-auth.js";

const SECRET = "workspace-secret-for-tests-0123456789abcdef";

function request(token: string | undefined): Request {
  return new Request("https://agent.test/eve/v1/session", {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

async function resolveUrl(url: string | (() => string | Promise<string>)): Promise<string> {
  return typeof url === "function" ? await url() : url;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspacePeers", () => {
  it("admits a token minted for this agent as a service principal", async () => {
    vi.stubEnv("EVE_WORKSPACE_SECRET", SECRET);
    vi.stubEnv("EVE_WORKSPACE_AGENT", "research");
    const token = mintWorkspacePeerToken({
      callee: "research",
      caller: "coordinator",
      secret: SECRET,
    });

    await expect(workspacePeers()(request(token))).resolves.toMatchObject({
      principalId: "eve-workspace:coordinator",
      principalType: "service",
    });
  });

  it.each([
    [
      "a token for another agent",
      () => mintWorkspacePeerToken({ callee: "billing", caller: "coordinator", secret: SECRET }),
    ],
    [
      "a token signed with another secret",
      () =>
        mintWorkspacePeerToken({
          callee: "research",
          caller: "coordinator",
          secret: `${SECRET}-other`,
        }),
    ],
    [
      "an expired token",
      () =>
        mintWorkspacePeerToken({
          callee: "research",
          caller: "coordinator",
          now: Date.now() - 3_600_000,
          secret: SECRET,
        }),
    ],
    ["no token", () => undefined],
  ])("rejects %s", async (_name, token) => {
    vi.stubEnv("EVE_WORKSPACE_SECRET", SECRET);
    vi.stubEnv("EVE_WORKSPACE_AGENT", "research");

    await expect(workspacePeers()(request(token()))).resolves.toBeNull();
  });

  it("admits nobody outside a workspace host", async () => {
    vi.stubEnv("EVE_WORKSPACE_SECRET", undefined);
    const token = mintWorkspacePeerToken({
      callee: "research",
      caller: "coordinator",
      secret: SECRET,
    });

    await expect(workspacePeers()(request(token))).resolves.toBeNull();
  });
});

describe("workspace host configuration", () => {
  it("rejects a short workspace secret", () => {
    vi.stubEnv("EVE_WORKSPACE_SECRET", "short");

    expect(() => readWorkspaceSecret()).toThrow("at least 32 characters");
  });

  it("parses peer origins and rejects malformed values", () => {
    vi.stubEnv(
      "EVE_WORKSPACE_PEERS",
      JSON.stringify({ research: "http://127.0.0.1:4100/ignored" }),
    );
    expect(readWorkspacePeers()).toEqual({ research: "http://127.0.0.1:4100" });

    vi.stubEnv("EVE_WORKSPACE_PEERS", JSON.stringify(["http://127.0.0.1:4100"]));
    expect(() => readWorkspacePeers()).toThrow("must be a JSON object");
  });

  it("allows only exactly listed callback origins", () => {
    vi.stubEnv("EVE_CALLBACK_ALLOWED_ORIGINS", "http://127.0.0.1:4100, http://127.0.0.1:4200");

    expect(isAllowedCallbackOrigin("http://127.0.0.1:4100")).toBe(true);
    expect(isAllowedCallbackOrigin("http://127.0.0.1:4101")).toBe(false);
    expect(isAllowedCallbackOrigin("http://localhost:4100")).toBe(false);
    expect(isAllowedCallbackOrigin("https://127.0.0.1:4100")).toBe(false);

    vi.stubEnv("EVE_CALLBACK_ALLOWED_ORIGINS", undefined);
    expect(isAllowedCallbackOrigin("http://127.0.0.1:4100")).toBe(false);
  });
});

describe("default workspace-agent transport off Vercel", () => {
  it("calls the peer's workspace origin with a token for that peer", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("EVE_WORKSPACE_SECRET", SECRET);
    vi.stubEnv("EVE_WORKSPACE_AGENT", "coordinator");
    vi.stubEnv("EVE_WORKSPACE_PEERS", JSON.stringify({ research: "http://127.0.0.1:4100" }));
    const agent = defineWorkspaceAgent({ name: "research" });

    expect(await resolveUrl(agent.url)).toBe("http://127.0.0.1:4100");
    const { headers } = (await agent.auth?.()) ?? { headers: {} };
    vi.stubEnv("EVE_WORKSPACE_AGENT", "research");
    await expect(
      workspacePeers()(request(headers.authorization?.replace(/^Bearer /u, ""))),
    ).resolves.toMatchObject({ principalId: "eve-workspace:coordinator" });
  });

  it("names the running agents when the peer is not part of the workspace", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("EVE_WORKSPACE_PEERS", JSON.stringify({ research: "http://127.0.0.1:4100" }));
    const agent = defineWorkspaceAgent({ name: "billing" });

    await expect(resolveUrl(agent.url)).rejects.toThrow(
      'Workspace agent "billing" is not running in this workspace',
    );
  });
});

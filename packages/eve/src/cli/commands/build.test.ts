import { describe, expect, it } from "vitest";

import { workspaceSelfHostingHint } from "./build.js";

describe("workspaceSelfHostingHint", () => {
  it("names the Vercel output and the per-member self-hosting commands", () => {
    const hint = workspaceSelfHostingHint({
      root: "/repo",
      members: [
        { appRoot: "/repo/agents/support", name: "support" },
        { appRoot: "/repo/agents/research", name: "research" },
      ],
    });

    expect(hint).toContain("writes Vercel Build Output");
    expect(hint).toContain("(cd agents/support && eve build && eve start)");
    expect(hint).toContain("(cd agents/research && eve build && eve start)");
  });
});

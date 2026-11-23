import { afterEach, describe, expect, it, vi } from "vitest";

import { anthropic } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic", () => {
  it("calls the configured base URL with the explicit key, not AI Gateway", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({
        content: [{ text: "Hello Alice.", type: "text" }],
        id: "msg_1",
        model: "claude-test",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    });
    const model = anthropic("claude-test", {
      apiKey: "sk-ant-explicit",
      baseURL: "http://anthropic-mock.test/v1",
    });
    expect(model.provider).toBe("anthropic.messages");
    const result = await model.doGenerate({
      prompt: [{ content: [{ text: "Hi", type: "text" }], role: "user" }],
    });
    expect(result.content).toEqual([{ text: "Hello Alice.", type: "text" }]);
    expect(requests[0]?.url).toBe("http://anthropic-mock.test/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("sk-ant-explicit");
    expect(JSON.stringify(model)).not.toContain("sk-ant-explicit");
  });
});

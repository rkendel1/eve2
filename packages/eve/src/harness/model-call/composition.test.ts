import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { composeRequest } from "./composition.js";

const model = { modelId: "claude-sonnet-5", provider: "anthropic.messages" };
const SECRET = "sk-ant-api03-alice-very-secret-value";

function request(overrides: Partial<LanguageModelV4CallOptions> = {}) {
  return {
    prompt: [
      { content: "You are the release assistant.", role: "system" },
      { content: [{ text: "Alice asks for the release notes.", type: "text" }], role: "user" },
      {
        content: [{ input: {}, toolCallId: "call-1", toolName: "fetch_notes", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: "Notes: ".repeat(200) },
            toolCallId: "call-1",
            toolName: "fetch_notes",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ],
    tools: [
      {
        description: "Fetch the notes.",
        inputSchema: { type: "object" },
        name: "fetch_notes",
        type: "function",
      },
    ],
    ...overrides,
  } as Pick<LanguageModelV4CallOptions, "prompt" | "tools" | "providerOptions">;
}

describe("composeRequest", () => {
  it("splits the request into categories that add up to the total, with tool output inside history", () => {
    const { messages, tokens } = composeRequest(request(), model);
    expect(messages).toBe(3);
    expect(tokens.total).toBe(tokens.system + tokens.tools + tokens.history);
    expect(tokens.system).toBe(estimateTokens("You are the release assistant."));
    expect(tokens.toolOutputs).toBeGreaterThan(300);
    expect(tokens.toolOutputs).toBeLessThan(tokens.history);
    expect(tokens.summaries).toBe(0);
  });

  it("hashes identical requests alike, and a changed prefix or message differently", () => {
    const base = composeRequest(request(), model);
    expect(composeRequest(request(), model)).toEqual(base);
    const instructions = request();
    instructions.prompt[0] = { content: "You are the incident assistant.", role: "system" };
    const changedSystem = composeRequest(instructions, model);
    expect(changedSystem.prefixHash).not.toBe(base.prefixHash);
    const renamedTool = composeRequest(
      request({
        tools: [{ inputSchema: { type: "object" }, name: "fetch_report", type: "function" }],
      }),
      model,
    );
    expect(renamedTool.prefixHash).not.toBe(base.prefixHash);
    const longer = request();
    longer.prompt.push({ content: [{ text: "And the dates?", type: "text" }], role: "user" });
    const appended = composeRequest(longer, model);
    expect(appended.prefixHash).toBe(base.prefixHash);
    expect(appended.requestHash).not.toBe(base.requestHash);
  });

  it("keeps credentials and provider options out of the record and out of the hashes", () => {
    const withSecret = (secret: string) =>
      composeRequest(
        request({
          providerOptions: { gateway: { caching: "auto" }, openai: { apiKey: secret } },
          tools: [
            {
              args: { apiKey: secret },
              id: "acme.search",
              name: "search",
              type: "provider",
            },
          ],
        }),
        model,
      );
    const one = withSecret(SECRET);
    expect(JSON.stringify(one)).not.toContain(SECRET);
    expect(withSecret("another-value")).toEqual(one);
    expect(one.cache).toEqual({ gateway: "auto", markers: 0 });
  });

  it("counts cache markers and a compaction summary at the head of the history", () => {
    const summarized = request();
    summarized.prompt.splice(
      1,
      0,
      { content: [{ text: COMPACTION_CHECKPOINT_MARKER, type: "text" }], role: "user" },
      { content: [{ text: "Alice shipped 1.2.", type: "text" }], role: "assistant" },
    );
    summarized.prompt[0] = {
      content: "You are the release assistant.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      role: "system",
    };
    const { cache, tokens } = composeRequest(summarized, model);
    expect(cache).toEqual({ markers: 1 });
    expect(tokens.summaries).toBeGreaterThan(0);
    expect(tokens.summaries + tokens.toolOutputs).toBeLessThanOrEqual(tokens.history);
    expect(composeRequest(summarized, model).prefixHash).toBe(
      composeRequest(request(), model).prefixHash,
    );
  });

  it("does not take a marker later in the conversation for a summary", () => {
    const quoted = request();
    quoted.prompt.push({
      content: [{ text: COMPACTION_CHECKPOINT_MARKER, type: "text" }],
      role: "user",
    });
    expect(composeRequest(quoted, model).tokens.summaries).toBe(0);
  });
});

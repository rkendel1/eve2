const asCapability = (tool) => tool.replace(/_/g, ".");
const asTool = (capability) => capability.replace(/\./g, "_");
const text = (content) =>
  typeof content === "string"
    ? content
    : content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
const outputText = (output) =>
  output?.type === "text" || output?.type === "error-text"
    ? String(output.value)
    : JSON.stringify(output?.value ?? output);

export function generationRequest(options) {
  const messages = [];
  for (const m of options.prompt) {
    if (m.role === "system") messages.push({ role: "system", content: m.content });
    else if (m.role === "user") messages.push({ role: "user", content: text(m.content) });
    else if (m.role === "assistant") {
      const calls = m.content
        .filter((p) => p.type === "tool-call")
        .map((p) => ({
          id: p.toolCallId,
          name: asCapability(p.toolName),
          input: typeof p.input === "string" ? JSON.parse(p.input || "{}") : (p.input ?? {}),
        }));
      messages.push({
        role: "assistant",
        content: text(m.content),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    } else if (m.role === "tool") {
      for (const p of m.content.filter((part) => part.type === "tool-result"))
        messages.push({ role: "tool", toolCallId: p.toolCallId, content: outputText(p.output) });
    }
  }
  const tools = (options.tools ?? [])
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: asCapability(t.name),
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));
  return {
    messages,
    ...(tools.length ? { tools } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}

const FINISH = {
  stop: "stop",
  tool_calls: "tool-calls",
  length: "length",
  refusal: "content-filter",
  cancelled: "other",
};

export function streamParts(result) {
  const usage = {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: result.usage.inputTokens ?? undefined,
      total: result.usage.inputTokens ?? undefined,
    },
    outputTokens: {
      reasoning: undefined,
      text: result.usage.outputTokens ?? undefined,
      total: result.usage.outputTokens ?? undefined,
    },
  };
  return [
    { type: "stream-start", warnings: [] },
    ...(result.text
      ? [
          { id: "t", type: "text-start" },
          { id: "t", type: "text-delta", delta: result.text },
          { id: "t", type: "text-end" },
        ]
      : []),
    ...result.toolCalls.map((c) => ({
      type: "tool-call",
      toolCallId: c.id,
      toolName: asTool(c.name),
      input: JSON.stringify(c.input),
    })),
    {
      type: "finish",
      finishReason: { raw: result.finish, unified: FINISH[result.finish] ?? "other" },
      usage,
    },
  ];
}

export class GenerateLanguageModel {
  specificationVersion = "v4";
  provider = "appboundry.model";
  supportedUrls = {};
  constructor(id, generate) {
    this.modelId = id;
    this.generate = generate;
  }
  async doGenerate() {
    throw new Error("eve streams its model calls");
  }
  async doStream(options) {
    const parts = streamParts(await this.generate(generationRequest(options)));
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  }
}

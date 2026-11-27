import { defineTool } from "eve/tools";

import { invokeCapability } from "../lib/capability.ts";

export default defineTool({
  description:
    "Reads one pull request: its state, whether it was merged, and the files it changed.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      number: { type: "integer" },
      repository: { description: "owner/name", type: "string" },
    },
    required: ["repository", "number"],
    type: "object",
  },
  execute: async (input, ctx) =>
    await invokeCapability("repo.changes.get", input, `${ctx.session.id}:${ctx.callId}`),
});

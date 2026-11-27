import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

import { invokeCapability } from "../lib/capability.ts";

export default defineTool({
  approval: always(),
  description: "Publishes a prepared change as a pull request. A person must approve each call.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      repository: { description: "owner/name", type: "string" },
      title: { type: "string" },
    },
    required: ["repository", "title"],
    type: "object",
  },
  execute: async (input, ctx) =>
    await invokeCapability("repo.changes.publish", input, `${ctx.session.id}:${ctx.callId}`),
});

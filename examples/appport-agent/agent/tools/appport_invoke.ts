import { defineTool } from "eve/tools";
import { z } from "zod";

import { invokeCapability } from "../lib/appport";

export default defineTool({
  description:
    "Invokes one read-only AppPort capability as the current caller. Input must match the capability's input schema. Returns the result or AppPort's rejection, with the invocation's requestId.",
  inputSchema: z.object({
    input: z.record(z.string(), z.unknown()),
    name: z.string().min(1),
  }),
  async execute({ input, name }, ctx) {
    const principalId = ctx.session.auth?.current?.principalId;
    if (principalId === undefined) return { error: "No authenticated caller." };
    return await invokeCapability({ principalId }, name, input, ctx.session.id);
  },
});

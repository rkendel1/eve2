import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { invokeCapability } from "../lib/appport";
import { fault } from "../lib/faults";
import { AGENT_ID, readSubmission, recordInvocation, workForSession } from "../lib/work";

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
    const workId = await workForSession(ctx.session.id);
    const result = await invokeCapability({ principalId }, name, input, workId ?? ctx.session.id);
    if (workId !== null) {
      const submission = await readSubmission(workId);
      await fault("invocation.record", { objective: submission?.objective ?? "", workId });
      await recordInvocation({
        agent: AGENT_ID,
        callId: ctx.callId,
        capability: name,
        caller: principalId,
        errorCode: result.ok ? null : result.error.code,
        ok: result.ok,
        outputDigest: result.ok
          ? `sha256:${createHash("sha256").update(JSON.stringify(result.output)).digest("hex")}`
          : null,
        requestId: result.requestId,
        workId,
      });
    }
    return result;
  },
});

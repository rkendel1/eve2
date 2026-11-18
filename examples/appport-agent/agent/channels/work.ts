import { defineChannel, GET, POST } from "eve/channels";
import { jwtHmac, routeAuth } from "eve/channels/auth";
import { call, reply } from "eve/events";
import { toolResultFrom } from "eve/tools";

import {
  acceptWork,
  currentWork,
  readInvocation,
  readWork,
  recordProgress,
  workEvidence,
} from "../lib/work";
import appportInvoke from "../tools/appport_invoke";

const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_KEY_LENGTH = 200;

const auth = [
  jwtHmac({
    algorithm: "HS256",
    audiences: [process.env.AGENT_JWT_AUDIENCE ?? "appport-agent"],
    issuer: process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator",
    secret: process.env.AGENT_JWT_SECRET ?? "",
  }),
];

const problem = (status: number, code: string, message: string) =>
  Response.json({ code, message, ok: false }, { status });

export default defineChannel({
  routes: [
    POST("/work", async (request, { from }) => {
      const caller = await routeAuth(request, auth);
      if (caller instanceof Response) return caller;
      const principalId = caller.principalId;
      if (principalId === undefined) return problem(401, "UNAUTHENTICATED", "No principal.");
      const key = request.headers.get("idempotency-key") ?? "";
      if (key.length === 0 || key.length > MAX_KEY_LENGTH)
        return problem(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header.");
      const body = (await request.json().catch(() => null)) as { objective?: unknown } | null;
      const objective = body?.objective;
      if (
        typeof objective !== "string" ||
        objective.length === 0 ||
        objective.length > MAX_OBJECTIVE_LENGTH
      )
        return problem(400, "INVALID_OBJECTIVE", "objective must be a non-empty string.");

      const submission = await acceptWork(principalId, key, objective);
      if (submission.outcome === "conflict")
        return problem(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This key was used for a different objective.",
        );
      const workId = submission.task.task_id;
      const delivery = await from(workId).send(objective, {
        auth: caller,
        idempotencyKey: `work:${workId}`,
      });
      return Response.json(
        { replayed: submission.outcome === "replayed", sessionId: delivery.sessionId, workId },
        { status: submission.outcome === "accepted" ? 201 : 200 },
      );
    }),

    GET("/work/:workId", async (request, { params, resolveSession }) => {
      const caller = await routeAuth(request, auth);
      if (caller instanceof Response) return caller;
      const workId = params.workId ?? "";
      const work =
        caller.principalId === undefined ? null : await readWork(caller.principalId, workId);
      if (work === null) return problem(404, "WORK_NOT_FOUND", "No such work.");
      const live = await resolveSession(workId);
      return Response.json({ ...work, liveSessionId: live?.id ?? null });
    }),
  ],

  events: {
    async "turn.started"(_event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      currentWork.update(() => workId);
      await recordProgress(workId, {
        execution: { adapter: "eve", conversation_id: ctx.session.id },
        status: "running",
        summary: `Running in eve session ${ctx.session.id}.`,
      });
    },

    async "call.settled"(event, ctx) {
      const result = toolResultFrom(call(ctx.view, event.data.callId), appportInvoke);
      if (result === undefined || !("requestId" in result.output)) return;
      const invocation = await readInvocation(result.output.requestId);
      if (invocation === null) return;
      const outcome = result.output.ok ? "succeeded" : `was rejected (${result.output.error.code})`;
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      await recordProgress(workId, {
        evidence: [
          { collection: "appport_invocations", id: result.output.requestId, kind: "record" },
        ],
        status: "running",
        summary: `AppPort ${String(invocation.capability)} ${outcome}.`,
      });
    },

    async "turn.settled"(event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      const invocations = await Promise.all(
        (await workEvidence(workId)).map((requestId) => readInvocation(requestId)),
      );
      const succeeded = invocations.filter((entry) => entry?.ok === true).length;
      const text = reply(ctx.view, event.data.turnId)
        .map((part) => (part.kind === "text" ? String(part.value ?? "") : ""))
        .join("")
        .slice(0, 2000);
      if (event.data.outcome !== "completed") {
        await recordProgress(workId, {
          decisions: [`failed: the eve turn ended ${event.data.outcome}`],
          status: "blocked",
          summary: `Failed: the eve turn ended ${event.data.outcome}.`,
        });
      } else if (invocations.length > 0 && succeeded === 0) {
        await recordProgress(workId, {
          decisions: ["waiting: every AppPort invocation was rejected"],
          status: "blocked",
          summary: `Blocked: no capability invocation was authorized. Agent reply: ${text}`,
        });
      } else {
        await recordProgress(workId, {
          decisions: [`completed after ${succeeded} authorized invocation(s)`],
          status: "completed",
          summary: `Completed. Agent reply: ${text}`,
        });
      }
    },
  },
});

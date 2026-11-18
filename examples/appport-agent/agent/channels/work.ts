import { defineChannel, GET, POST } from "eve/channels";
import { jwtHmac, routeAuth } from "eve/channels/auth";
import { call } from "eve/events";
import { toolResultFrom } from "eve/tools";

import { fault } from "../lib/faults";
import { invokeCallsOf, reconcileAll, replyOf } from "../lib/recovery";
import { decideOutcome, readOperation } from "../lib/operations";
import {
  acceptWork,
  bindSession,
  citeNew,
  readCallLink,
  readSubmission,
  readWork,
  recordProgress,
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

type Operations = Parameters<typeof reconcileAll>[0];
let startupReconciliation: Promise<unknown> | undefined;

function reconcileOnce(ops: Operations) {
  startupReconciliation ??= reconcileAll(ops).catch((error: unknown) => {
    startupReconciliation = undefined;
    throw error;
  });
  return startupReconciliation;
}

export default defineChannel({
  routes: [
    POST("/work", async (request, { from, resolveSession }) => {
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
      await reconcileOnce({ from, resolveSession });

      const acceptance = await acceptWork({ ...caller, principalId }, key, objective);
      if (acceptance.outcome === "conflict")
        return problem(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This key was used for a different objective.",
        );
      const { workId } = acceptance;
      await fault("work.accepted", { objective, workId });
      const delivery = await from(workId).send(objective, {
        auth: caller,
        idempotencyKey: `work:${workId}`,
      });
      return Response.json(
        { replayed: acceptance.outcome === "replayed", sessionId: delivery.sessionId, workId },
        { status: acceptance.outcome === "accepted" ? 201 : 200 },
      );
    }),

    GET("/work/:workId", async (request, { from, params, resolveSession }) => {
      const caller = await routeAuth(request, auth);
      if (caller instanceof Response) return caller;
      await reconcileOnce({ from, resolveSession });
      const workId = params.workId ?? "";
      const work =
        caller.principalId === undefined ? null : await readWork(caller.principalId, workId);
      if (work === null) return problem(404, "WORK_NOT_FOUND", "No such work.");
      const live = await resolveSession(workId);
      return Response.json({ ...work, liveSessionId: live?.id ?? null });
    }),

    POST("/work/reconcile", async (request, { from, resolveSession }) => {
      const caller = await routeAuth(request, auth);
      if (caller instanceof Response) return caller;
      const operator = process.env.APPPORT_AGENT_OPERATOR;
      if (operator === undefined || caller.principalId !== operator)
        return problem(403, "FORBIDDEN", "Only the operator may reconcile work.");
      const results = await reconcileAll({ from, resolveSession });
      return Response.json({ results });
    }),
  ],

  events: {
    async "turn.started"(_event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      await bindSession(ctx.session.id, workId);
      await recordProgress(workId, (current) =>
        current.task.status === "running" &&
        current.checkpoint.execution?.conversation_id === ctx.session.id
          ? null
          : {
              execution: { adapter: "eve", conversation_id: ctx.session.id },
              status: "running",
              summary: `Running in eve session ${ctx.session.id}.`,
            },
      );
    },

    async "call.settled"(event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      const result = toolResultFrom(call(ctx.view, event.data.callId), appportInvoke);
      if (result === undefined) return;
      const link = await readCallLink(workId, result.callId);
      if (link === null || link.operation_id === null) return;
      const operation = await readOperation(String(link.operation_id));
      if (operation === null || operation.work_id !== workId) return;
      if (operation.state !== "succeeded" && operation.state !== "failed") return;
      const outcome =
        operation.state === "succeeded"
          ? "succeeded"
          : `was rejected (${operation.outcome?.error?.code ?? "unknown"})`;
      await recordProgress(workId, (current) => {
        const evidence = citeNew(current.checkpoint, [operation.operation_id]);
        if (evidence.length === 0) return null;
        return {
          evidence,
          status: "running",
          summary: `AppPort ${operation.capability} ${outcome}.`,
        };
      });
    },

    async "turn.settled"(event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      const outcome = await decideOutcome(
        workId,
        event.data.outcome,
        invokeCallsOf(ctx.view),
        replyOf(ctx.view, event.data.turnId),
      );
      const submission = await readSubmission(workId);
      await fault("checkpoint.final", { objective: submission?.objective ?? "", workId });
      await recordProgress(workId, (current) => ({
        decisions: [outcome.decision],
        evidence: citeNew(current.checkpoint, outcome.evidence),
        status: outcome.status,
        summary: outcome.summary,
      }));
    },
  },
});

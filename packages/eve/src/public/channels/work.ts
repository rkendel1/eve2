import { isAnonymousPrincipal } from "#channel/principal-identity.js";
import { sessionAuthFromResult } from "#channel/auth/result.js";
import { deliveryIdForIdempotencyKey } from "#channel/delivery-idempotency.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import { readSessionView } from "#internal/a2a/task-projection.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import { INVOCATION_DIGEST_ATTRIBUTE, invocationOwnerKey } from "#internal/invocation/metadata.js";
import {
  invocationContinuationToken,
  readOwnedInvocationRun,
} from "#internal/invocation/owned-run.js";
import { createLogger, logError } from "#internal/logging.js";
import { readRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import {
  isWorkContinuationToken,
  workContinuationToken,
  workDeliveryKey,
  workSubmissionDigest,
} from "#internal/work/identity.js";
import {
  parseIdempotencyKey,
  parseWorkSubmission,
  type WorkRepository,
  type WorkSubmission,
} from "#internal/work/submission.js";
import {
  projectWorkStatus,
  WORK_CONTROLS,
  workResultOf,
  type WorkResult,
} from "#internal/work/status.js";
import { prepareRepository, readWorkspace, type WorkWorkspace } from "#internal/work/workspace.js";
import { routeAuth, type AuthFn } from "#public/channels/auth.js";
import {
  defineChannel,
  GET,
  POST,
  type Channel,
  type ChannelEventContext,
} from "#public/definitions/channel.js";

export type { WorkRepository, WorkSubmission } from "#internal/work/submission.js";
export type {
  WorkAttempt,
  WorkAttemptOutcome,
  WorkControl,
  WorkControlName,
  WorkResult,
  WorkState,
  WorkStatus,
} from "#internal/work/status.js";
export type { WorkGitState, WorkWorkspace } from "#internal/work/workspace.js";
export { WORK_CONTROLS } from "#internal/work/status.js";

/** A finished attempt with the facts read from its sandbox, as {@link WorkChannelConfig.onResult} receives it. */
export interface WorkAttemptResult extends WorkResult {
  /** The sandbox workspace after the attempt; `null` when the work named no repository. */
  readonly workspace: WorkWorkspace | null;
}

/** The durable channel state of one piece of work. */
export interface WorkChannelState {
  readonly repository: WorkRepository | null;
  baseCommit: string | null;
  workspaceError: string | null;
}

/** The context a {@link WorkChannelConfig.onResult} callback receives: the session's context and its sandbox. */
export type WorkResultContext = ChannelEventContext<{ state: WorkChannelState }>;

/** Options for {@link workChannel}. */
export interface WorkChannelConfig {
  /**
   * Who may submit and read work: an eve route-auth policy. Each piece of work belongs to the
   * principal that submitted it; anonymous callers are refused.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Route prefix. @default "/eve/v1/work" */
  readonly route?: string;
  /** Longest objective accepted, in characters. @default 32_000 */
  readonly maxObjectiveLength?: number;
  readonly workspace?: {
    /**
     * Hosts a submission's `repository.url` may name, such as `["github.com"]`. Without it,
     * submissions that name a repository are refused. The repository is checked out in the
     * session's sandbox before the first model call, using the sandbox's own network policy and
     * brokered credentials; URLs with credentials are refused.
     */
    readonly repositoryHosts?: readonly string[];
  };
  /**
   * Runs once per finished attempt (turn), inside the session, after its `turn.settled` event.
   * Persist or forward the result here. `ctx.getSandbox()` reaches the work's sandbox, for
   * example to commit or upload the workspace. It runs at least once per attempt; key on
   * `sessionId` and `turnId`.
   */
  readonly onResult?: (result: WorkAttemptResult, ctx: WorkResultContext) => void | Promise<void>;
}

/** The channel {@link workChannel} returns. */
export type WorkChannel = Channel<WorkChannelState>;

const DEFAULT_ROUTE = "/eve/v1/work";
const DEFAULT_MAX_OBJECTIVE_LENGTH = 32_000;
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_BODY_BYTES = 256 * 1024;
const NO_STORE = { "cache-control": "no-store" };
const log = createLogger("eve.channel.work");

/**
 * Publishes a work API: submit work with an idempotency key, steer it, interrupt or stop it,
 * follow its events from a durable cursor, and read its result. Each piece of work is one durable
 * eve session that belongs to the principal that submitted it.
 */
export function workChannel(input: WorkChannelConfig): WorkChannel {
  if (input?.auth === undefined) throw new Error("workChannel requires auth.");
  const route = input.route ?? DEFAULT_ROUTE;
  if (!route.startsWith("/") || route.endsWith("/")) {
    throw new Error("workChannel route must be an absolute path without a trailing slash.");
  }
  const limits = {
    maxObjectiveLength: input.maxObjectiveLength ?? DEFAULT_MAX_OBJECTIVE_LENGTH,
    repositoryHosts: (input.workspace?.repositoryHosts ?? []).map((host) => host.toLowerCase()),
  };

  const authenticate = async (request: Request) => {
    const caller = await routeAuth(request, input.auth);
    if (caller instanceof Response) return caller;
    const auth = sessionAuthFromResult(caller);
    if (isAnonymousPrincipal(auth)) {
      return problem(401, "unauthenticated", "Work needs an authenticated principal.");
    }
    return auth;
  };

  const ownedWork = async (request: Request, args: RouteHandlerArgs) => {
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    const sessionId = args.params.sessionId ?? "";
    const run = await readOwnedInvocationRun(sessionId, auth);
    if (run === undefined || !isWorkContinuationToken(invocationContinuationToken(run))) {
      return problem(404, "work_not_found", "No such work.");
    }
    return { auth, session: args.attachSession(sessionId), sessionId };
  };

  const submit = async (request: Request, args: RouteHandlerArgs) => {
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    const key = parseIdempotencyKey(request);
    if (!key.ok) return problem(400, key.code, key.message);
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const submission = parseWorkSubmission(body, limits);
    if (!submission.ok) return problem(400, submission.code, submission.message);
    const createSession = readRouteSessionCreator(args);
    if (createSession === undefined) {
      return problem(500, "internal_error", "workChannel requires agent route context.");
    }

    const ownerKey = invocationOwnerKey(auth);
    const token = workContinuationToken(ownerKey, key.value);
    const digest = workSubmissionDigest(submission.value);
    const deliveryKey = workDeliveryKey(token);
    const deliveryId = await deliveryIdForIdempotencyKey(deliveryKey);
    const existing = await args.resolveSession(token);
    if (existing !== undefined) return await replayed(existing.id, auth, digest, deliveryId);

    const state: WorkChannelState = {
      baseCommit: null,
      repository: submission.value.repository ?? null,
      workspaceError: null,
    };
    const handle = await createSession({
      auth,
      continuationToken: token,
      deliveryId,
      externalInvocation: { continuationToken: token, ownerKey, submissionDigest: digest },
      idempotencyKey: deliveryKey,
      input: {
        context: [...repositoryContext(submission.value), ...(submission.value.context ?? [])],
        message: submission.value.objective,
        state,
      },
    });
    if (handle.claimedContinuation === false) {
      return await replayed(handle.sessionId, auth, digest, deliveryId);
    }
    return Response.json(
      { controls: WORK_CONTROLS, deliveryId, replayed: false, sessionId: handle.sessionId },
      { headers: NO_STORE, status: 201 },
    );
  };

  const status = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    const view = await readSessionView(work.sessionId);
    return Response.json(projectWorkStatus(view, work.sessionId), { headers: NO_STORE });
  };

  const result = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    const current = projectWorkStatus(await readSessionView(work.sessionId), work.sessionId);
    const settled = workResultOf(current);
    if (settled === undefined || current.status === "running" || current.status === "queued") {
      return problem(
        409,
        "work_not_settled",
        `The work is ${current.status}; read it again later.`,
      );
    }
    return Response.json(settled, { headers: NO_STORE });
  };

  const events = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    return await createSessionStreamResponse(request, work.session);
  };

  const steer = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const message = (body as { message?: unknown } | null)?.message;
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      return problem(400, "invalid_message", "message must be a non-empty string.");
    }
    const key = request.headers.get("idempotency-key");
    return await command(work.sessionId, () =>
      work.session.send(message, {
        auth: work.auth,
        turnPolicy: "steer",
        ...(key !== null && key.length > 0 && key.length <= 200
          ? { idempotencyKey: `work-message:${work.sessionId}:${key}` }
          : {}),
      }),
    );
  };

  const interrupt = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    const turnId = await readTurnId(request);
    if (turnId instanceof Response) return turnId;
    return await command(work.sessionId, () =>
      work.session.cancel({ auth: work.auth, ...(turnId !== undefined && { turnId }) }),
    );
  };

  const stop = async (request: Request, args: RouteHandlerArgs) => {
    const work = await ownedWork(request, args);
    if (work instanceof Response) return work;
    return await command(work.sessionId, async () => {
      await work.session.cancel({ auth: work.auth });
      return await work.session.end({ auth: work.auth, reason: "Stopped through the work API." });
    });
  };

  return defineChannel<WorkChannelState, { state: WorkChannelState }>({
    context: (state) => ({ state }),
    events: {
      "turn.started": async (_event, ctx) => {
        const { state } = ctx.channel;
        if (
          state.repository === null ||
          state.baseCommit !== null ||
          state.workspaceError !== null
        ) {
          return;
        }
        const prepared = await prepareRepository(await ctx.getSandbox(), state.repository);
        if ("error" in prepared) state.workspaceError = prepared.error;
        else state.baseCommit = prepared.baseCommit;
      },
      "turn.settled": async (event, ctx) => {
        if (input.onResult === undefined) return;
        const settled = workResultOf(projectWorkStatus(sessionTables(ctx.view), ctx.session.id));
        if (settled === undefined || settled.turnId !== event.data.turnId) return;
        const { state } = ctx.channel;
        const workspace =
          state.repository === null
            ? null
            : await readWorkspace(
                await ctx.getSandbox(),
                state.repository,
                state.baseCommit,
                state.workspaceError,
              );
        await input.onResult({ ...settled, workspace }, ctx);
      },
    },
    routes: [
      POST(route, submit),
      GET(`${route}/:sessionId`, status),
      GET(`${route}/:sessionId/result`, result),
      GET(`${route}/:sessionId/events`, events),
      POST(`${route}/:sessionId/messages`, steer),
      POST(`${route}/:sessionId/interrupt`, interrupt),
      POST(`${route}/:sessionId/stop`, stop),
    ],
    state: { baseCommit: null, repository: null, workspaceError: null },
  });
}

async function replayed(
  sessionId: string,
  auth: SessionAuthContext,
  digest: string,
  deliveryId: string,
): Promise<Response> {
  const run = await readOwnedInvocationRun(sessionId, auth);
  if (run?.attributes[INVOCATION_DIGEST_ATTRIBUTE] !== digest) {
    return problem(
      409,
      "idempotency_key_reused",
      "This Idempotency-Key was used for different work. Use a new key.",
    );
  }
  return Response.json(
    { controls: WORK_CONTROLS, deliveryId, replayed: true, sessionId },
    { headers: NO_STORE, status: 200 },
  );
}

function repositoryContext(submission: WorkSubmission): string[] {
  const { repository } = submission;
  if (repository === undefined) return [];
  const at = repository.ref === undefined ? "" : ` at ${repository.ref}`;
  const branch = repository.branch === undefined ? "" : ` on branch ${repository.branch}`;
  return [
    `eve checks out ${repository.url}${at}${branch} in the workspace root before you start. If the workspace root is not a git checkout of it, report that the repository could not be prepared and stop.`,
  ];
}

async function command(
  sessionId: string,
  run: () => Promise<{ readonly deliveryId: string }>,
): Promise<Response> {
  try {
    const delivery = await run();
    return Response.json(
      { deliveryId: delivery.deliveryId, sessionId },
      { headers: NO_STORE, status: 202 },
    );
  } catch (error) {
    const response = sessionCommandErrorResponse(error);
    if (response !== undefined) return response;
    const errorId = logError(log, "work command failed", error, { sessionId });
    return Response.json(
      { code: "internal_error", errorId, message: "The command failed.", ok: false },
      { headers: NO_STORE, status: 500 },
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return problem(413, "body_too_large", "The body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return problem(413, "body_too_large", "The body is too large.");
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return problem(400, "invalid_body", "The body must be JSON.");
  }
}

async function readTurnId(request: Request): Promise<string | undefined | Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const turnId = (body as { turnId?: unknown } | null)?.turnId;
  if (turnId === undefined) return undefined;
  if (typeof turnId !== "string" || turnId.length === 0) {
    return problem(400, "invalid_turn_id", "turnId must be a non-empty string.");
  }
  return turnId;
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false }, { headers: NO_STORE, status });
}

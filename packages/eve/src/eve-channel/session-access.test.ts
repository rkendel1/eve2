import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { InternalSession } from "#channel/session.js";
import { sessionOwnerKey } from "#channel/session-owner.js";
import type { SessionAuthContext } from "#channel/types.js";
import { StreamDelivery } from "#client/delivery.js";
import { eveChannel } from "#eve-channel/index.js";
import type {
  EveChannelConfig,
  SessionAccessRequest,
  SessionOperation,
} from "#eve-channel/types.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "meetings",
  issuer: "org-a",
  principalId: "alice",
  principalType: "user",
};
const BOB: SessionAuthContext = { ...ALICE, principalId: "bob" };
const ALICE_OTHER_APPLICATION: SessionAuthContext = { ...ALICE, authenticator: "xeet" };
const ALICE_OTHER_ORGANIZATION: SessionAuthContext = { ...ALICE, issuer: "org-b" };
const ANONYMOUS: SessionAuthContext = {
  attributes: {},
  authenticator: "none",
  principalId: "anonymous",
  principalType: "anonymous",
};

type Route = readonly [SessionOperation, "GET" | "POST", string, string, unknown];

const ROUTES: readonly Route[] = [
  ["prepare", "POST", "/eve/v1/session/:sessionId", "", undefined],
  ["message", "POST", "/eve/v1/session/:sessionId", "", { message: "Hello" }],
  [
    "respond",
    "POST",
    "/eve/v1/session/:sessionId",
    "",
    { answers: [{ interactionId: "req_A", optionId: "approve" }] },
  ],
  ["control", "POST", "/eve/v1/session/:sessionId/cancel", "/cancel", {}],
  ["control", "POST", "/eve/v1/session/:sessionId/compact", "/compact", {}],
  ["control", "POST", "/eve/v1/session/:sessionId/clear", "/clear", {}],
  ["control", "POST", "/eve/v1/session/:sessionId/resume", "/resume", {}],
  ["control", "POST", "/eve/v1/session/:sessionId/end", "/end", {}],
  ["control", "POST", "/eve/v1/session/:sessionId/reset", "/reset", {}],
  ["read", "GET", "/eve/v1/session/:sessionId/stream", "/stream", undefined],
  [
    "read",
    "GET",
    "/eve/v1/session/:sessionId/descendants/stream",
    "/descendants/stream",
    undefined,
  ],
  ["read", "GET", "/eve/v1/session/:sessionId/stubs", "/stubs", undefined],
];

function fixedSession(ownerKey: string | null | undefined) {
  const receipt = new StreamDelivery({
    sessionId: "wrun_A",
    deliveryId: "delivery_A",
    createStream: async function* () {},
  });
  const acted = vi.fn().mockResolvedValue(receipt);
  const session = {
    id: "wrun_A",
    stream: async function* () {},
    send: acted,
    respond: acted,
    cancel: acted,
    prewarm: vi.fn(async () => {
      acted();
      return { status: "accepted" as const };
    }),
    compact: acted,
    clear: acted,
    resume: acted,
    end: acted,
    getLineStream: vi.fn(async () => {
      acted();
      return new ReadableStream({ start: (controller) => controller.close() });
    }),
    getStreamTailIndex: vi.fn(async () => {
      acted();
      return -1;
    }),
    hasRunnableOwner: vi.fn().mockResolvedValue(true),
    readOwnerKey: vi.fn().mockResolvedValue(ownerKey),
  } satisfies Partial<InternalSession> as InternalSession;
  return { acted, session };
}

async function call(
  config: Omit<EveChannelConfig, "auth">,
  caller: SessionAuthContext,
  ownerKey: string | null | undefined,
  [, method, path, suffix, body]: Route,
) {
  const route = eveChannel({
    auth: () => ({ ...caller, allowToolStubs: true }),
    ...config,
  }).routes!.find((candidate) => candidate.method === method && candidate.path === path)!;
  const { acted, session } = fixedSession(ownerKey);
  const args = {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(vi.fn()),
    attachSession: () => session,
    to: vi.fn() as never,
    params: { sessionId: "wrun_A" },
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  } satisfies RouteHandlerArgs;
  const response = (await route.handler(
    new Request(`https://eve.test/eve/v1/session/wrun_A${suffix}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    args,
  )) as Response;
  return { acted, body: await response.text(), status: response.status };
}

const ALICE_OWNS = sessionOwnerKey(ALICE);

describe("session access on the eve channel", () => {
  it.each(ROUTES)("admits the session's owner to %s on %s %s", async (...route: Route) => {
    const result = await call({}, ALICE, ALICE_OWNS, route);
    expect([404, 409]).not.toContain(result.status);
  });

  it.each(ROUTES)(
    "answers anyone else on %s %s %s exactly as for a session that does not exist",
    async (...route: Route) => {
      const unknown = await call({}, BOB, undefined, route);
      for (const [caller, ownerKey] of [
        [BOB, ALICE_OWNS],
        [ALICE_OTHER_APPLICATION, ALICE_OWNS],
        [ALICE_OTHER_ORGANIZATION, ALICE_OWNS],
        [ANONYMOUS, ALICE_OWNS],
        [ANONYMOUS, null],
        [ALICE, null],
      ] as const) {
        const denied = await call({}, caller, ownerKey, route);
        expect(denied).toEqual({ ...unknown, acted: denied.acted });
        expect(denied.acted).not.toHaveBeenCalled();
      }
      expect([404, 409]).toContain(unknown.status);
    },
  );

  it.each(ROUTES)(
    "asks sessionAccess about %s on %s %s, and only for a session that exists",
    async (...route: Route) => {
      const sessionAccess = vi.fn((_request: SessionAccessRequest) => true);
      const granted = await call({ sessionAccess }, BOB, ALICE_OWNS, route);
      expect([404, 409]).not.toContain(granted.status);
      expect(sessionAccess).toHaveBeenCalledWith({
        caller: expect.objectContaining({ principalId: "bob" }),
        operation: route[0],
        owner: false,
        sessionId: "wrun_A",
      });

      sessionAccess.mockClear();
      await call({ sessionAccess }, BOB, undefined, route);
      expect(sessionAccess).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "lets sessionAccess refuse even the owner %s on %s %s",
    async (...route: Route) => {
      const refused = await call({ sessionAccess: () => false }, ALICE, ALICE_OWNS, route);
      const unknown = await call({}, ALICE, undefined, route);
      expect(refused).toEqual({ ...unknown, acted: refused.acted });
      expect(refused.acted).not.toHaveBeenCalled();
    },
  );

  it("answers a subagent stream under someone else's session as not found", async () => {
    const route = eveChannel({ auth: () => BOB }).routes!.find(
      (candidate) =>
        candidate.method === "GET" &&
        candidate.path ===
          "/eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream",
    )!;
    const { session } = fixedSession(ALICE_OWNS);
    const getChildBinding = vi.fn();
    const response = (await route.handler(
      new Request("https://eve.test/eve/v1/session/wrun_A/subagents/call_A/wrun_B/stream"),
      {
        ...mockAgentRouteArgs(),
        ...mockChannelContext(vi.fn()),
        attachSession: () => ({ ...session, getChildBinding }) as never,
        to: vi.fn() as never,
        params: { parentSessionId: "wrun_A", callId: "call_A", childSessionId: "wrun_B" },
        waitUntil: vi.fn(),
        requestIp: "127.0.0.1",
      },
    )) as Response;
    expect(response.status).toBe(404);
    expect(getChildBinding).not.toHaveBeenCalled();
  });
});

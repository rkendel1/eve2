import { internalSession, type Session } from "#channel/session.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { sessionOwnerKey } from "#channel/session-owner.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionAccessPolicy, SessionOperation } from "./types.js";
import { sessionCommandErrorResponse } from "./support.js";

export async function canAccessSession(
  session: Session,
  caller: SessionAuthContext,
  operation: SessionOperation,
  policy: SessionAccessPolicy | undefined,
): Promise<boolean> {
  const ownerKey = await internalSession(session).readOwnerKey();
  if (ownerKey === undefined) return false;
  const owner = ownerKey !== null && sessionOwnerKey(caller) === ownerKey;
  if (policy === undefined) return owner;
  return (await policy({ caller, operation, owner, sessionId: session.id })) === true;
}

export function deniedSessionResponse(operation: SessionOperation): Response {
  if (operation === "read") {
    return Response.json(
      { code: "session_not_found", error: "No such session.", ok: false },
      { headers: { "cache-control": "no-store" }, status: 404 },
    );
  }
  return sessionCommandErrorResponse(new SessionNotActiveError())!;
}

export async function sessionAccessDenial(
  session: Session,
  caller: SessionAuthContext,
  operation: SessionOperation,
  policy: SessionAccessPolicy | undefined,
): Promise<Response | undefined> {
  return (await canAccessSession(session, caller, operation, policy))
    ? undefined
    : deniedSessionResponse(operation);
}

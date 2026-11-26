import { isAnonymousPrincipal } from "#channel/principal-identity.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";

export const SESSION_OWNER_ATTRIBUTE = "$eve.session_owner";

export function sessionOwnerKey(auth: SessionAuthContext | null | undefined): string | undefined {
  if (auth === null || auth === undefined || isAnonymousPrincipal(auth)) return undefined;
  return invocationOwnerKey(auth);
}

export function runInputOwnerKey(input: RunInput): string | undefined {
  return sessionOwnerKey(
    input.sessionOwner !== undefined ? input.sessionOwner : (input.initiatorAuth ?? input.auth),
  );
}

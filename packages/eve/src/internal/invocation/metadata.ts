import { createHash } from "#platform/crypto.js";

import { principalIdentity } from "#channel/principal-identity.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import {
  INVOCATION_DIGEST_ATTRIBUTE,
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/attributes.js";

export { INVOCATION_DIGEST_ATTRIBUTE, INVOCATION_OWNER_ATTRIBUTE, INVOCATION_TOKEN_ATTRIBUTE };

type ExternalInvocationMetadata = NonNullable<RunInput["externalInvocation"]>;

export function invocationOwnerKey(auth: SessionAuthContext | null): string {
  const identity = auth === null ? ["anonymous"] : principalIdentity(auth);
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
    ...(metadata.submissionDigest !== undefined && {
      [INVOCATION_DIGEST_ATTRIBUTE]: metadata.submissionDigest,
    }),
  };
}

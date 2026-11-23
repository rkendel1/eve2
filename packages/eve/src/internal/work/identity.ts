import { createHash } from "node:crypto";

import type { WorkSubmission } from "./submission.js";

const WORK_TOKEN_PREFIX = "work:";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function workContinuationToken(ownerKey: string, idempotencyKey: string): string {
  return `${WORK_TOKEN_PREFIX}${sha256(`${ownerKey}\0${idempotencyKey}`).slice(0, 40)}`;
}

export function isWorkContinuationToken(token: string | undefined): boolean {
  return token?.startsWith(WORK_TOKEN_PREFIX) === true;
}

export function workSubmissionDigest(submission: WorkSubmission): string {
  return sha256(
    JSON.stringify([
      submission.objective,
      submission.context ?? [],
      submission.repository === undefined
        ? null
        : [
            submission.repository.url,
            submission.repository.ref ?? null,
            submission.repository.branch ?? null,
          ],
    ]),
  );
}

export function workDeliveryKey(token: string): string {
  return `${token}:submission`;
}

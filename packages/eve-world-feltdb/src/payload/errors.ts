/** A referenced payload is not stored: its index record or its bytes are gone. */
export class PayloadMissingError extends Error {
  override readonly name = "PayloadMissingError";
  readonly code = "PAYLOAD_MISSING";
  readonly digest: string;

  constructor(digest: string) {
    super(`PAYLOAD_MISSING: payload ${digest} is not stored`);
    this.digest = digest;
  }
}

/** Stored bytes no longer match their digest. They are never returned. */
export class PayloadIntegrityError extends Error {
  override readonly name = "PayloadIntegrityError";
  readonly code = "PAYLOAD_INTEGRITY_FAILURE";
  readonly digest: string;

  constructor(digest: string, reason: string) {
    super(
      `PAYLOAD_INTEGRITY_FAILURE: payload ${digest} failed verification (${reason}); it was not returned`,
    );
    this.digest = digest;
  }
}

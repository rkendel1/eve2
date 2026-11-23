/** A repository a piece of work checks out in its sandbox before the first model call. */
export interface WorkRepository {
  /** An `https` URL on an allowed host, without credentials. */
  readonly url: string;
  /** The branch, tag, or commit to fetch. @default "HEAD" */
  readonly ref?: string;
  /** A branch to create or reset at the fetched commit for the work's changes. */
  readonly branch?: string;
}

/** The body of a work submission. */
export interface WorkSubmission {
  /** What the agent should do; the session's first message. */
  readonly objective: string;
  /** Extra strings the session receives before the objective. */
  readonly context?: readonly string[];
  /** A repository to check out before the first model call. */
  readonly repository?: WorkRepository;
}

export interface WorkSubmissionLimits {
  readonly maxObjectiveLength: number;
  readonly repositoryHosts: readonly string[];
}

export type WorkInputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

const MAX_CONTEXT_ENTRIES = 16;
const MAX_CONTEXT_LENGTH = 8_000;
const GIT_REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/u;
const SUBMISSION_FIELDS = new Set(["objective", "context", "repository"]);
const REPOSITORY_FIELDS = new Set(["url", "ref", "branch"]);

function invalid(code: string, message: string): WorkInputResult<never> {
  return { code, message, ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkSubmission(
  body: unknown,
  limits: WorkSubmissionLimits,
): WorkInputResult<WorkSubmission> {
  if (!isRecord(body)) return invalid("invalid_body", "Send a JSON object.");
  const unknown = Object.keys(body).filter((key) => !SUBMISSION_FIELDS.has(key));
  if (unknown.length > 0) {
    return invalid("invalid_body", `Unknown field: ${unknown.slice(0, 5).join(", ")}.`);
  }
  const { objective, context, repository } = body;
  if (
    typeof objective !== "string" ||
    objective.trim().length === 0 ||
    objective.length > limits.maxObjectiveLength
  ) {
    return invalid(
      "invalid_objective",
      `objective must be a non-empty string of at most ${limits.maxObjectiveLength} characters.`,
    );
  }
  if (
    context !== undefined &&
    (!Array.isArray(context) ||
      context.length > MAX_CONTEXT_ENTRIES ||
      context.some((entry) => typeof entry !== "string" || entry.length > MAX_CONTEXT_LENGTH))
  ) {
    return invalid(
      "invalid_context",
      `context must be at most ${MAX_CONTEXT_ENTRIES} strings of at most ${MAX_CONTEXT_LENGTH} characters.`,
    );
  }
  const parsedRepository =
    repository === undefined ? undefined : parseWorkRepository(repository, limits.repositoryHosts);
  if (parsedRepository !== undefined && !parsedRepository.ok) return parsedRepository;
  return {
    ok: true,
    value: {
      objective,
      ...(context !== undefined && { context: context as string[] }),
      ...(parsedRepository !== undefined && { repository: parsedRepository.value }),
    },
  };
}

export function parseWorkRepository(
  value: unknown,
  allowedHosts: readonly string[],
): WorkInputResult<WorkRepository> {
  if (allowedHosts.length === 0) {
    return invalid(
      "repository_not_allowed",
      "This agent accepts no repository per work. Configure workspace.repositoryHosts in workChannel().",
    );
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !REPOSITORY_FIELDS.has(key))) {
    return invalid("invalid_repository", "repository must be { url, ref?, branch? }.");
  }
  let url: URL;
  try {
    url = new URL(String(value.url));
  } catch {
    return invalid("invalid_repository", "repository.url must be an absolute https URL.");
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
    return invalid("invalid_repository", "repository.url must be an https URL without a query.");
  }
  if (url.username !== "" || url.password !== "") {
    return invalid(
      "invalid_repository",
      "repository.url must not carry credentials. Broker them through the sandbox's network policy.",
    );
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    return invalid("repository_not_allowed", `Repository host ${url.hostname} is not allowed.`);
  }
  for (const field of ["ref", "branch"] as const) {
    const ref = value[field];
    if (ref !== undefined && (typeof ref !== "string" || !GIT_REF.test(ref))) {
      return invalid(
        "invalid_repository",
        `repository.${field} must be a git branch, tag, or commit.`,
      );
    }
  }
  return {
    ok: true,
    value: {
      url: url.toString(),
      ...(typeof value.ref === "string" && { ref: value.ref }),
      ...(typeof value.branch === "string" && { branch: value.branch }),
    },
  };
}

export function parseIdempotencyKey(request: Request): WorkInputResult<string> {
  const key = request.headers.get("idempotency-key");
  if (key === null || key.length === 0 || key.length > 200) {
    return invalid(
      "idempotency_key_required",
      "Send an Idempotency-Key header of 1 to 200 characters.",
    );
  }
  return { ok: true, value: key };
}

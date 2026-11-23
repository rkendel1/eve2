import { queue, replyText, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView, TurnRow } from "#protocol/session-projection/tables.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { RuntimeIdentity } from "#protocol/session-events/families/session.js";

/** Where a piece of work is: waiting for its first attempt, running, waiting for input, its latest attempt's outcome, or ended. */
export type WorkState =
  | "queued"
  | "running"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "cancelled"
  | "ended";

/** How an attempt ended. */
export type WorkAttemptOutcome = "completed" | "failed" | "cancelled";

/** One attempt at the work: one turn of its session. */
export interface WorkAttempt {
  readonly turnId: string;
  readonly status: "running" | "settled";
  readonly outcome?: WorkAttemptOutcome;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/** Whether the runtime performs a control, and whether it stops a model or tool step already running. */
export interface WorkControl {
  readonly supported: boolean;
  readonly preemptsModelStep: boolean;
  readonly preemptsToolStep: "abort-signal" | "no";
  readonly description: string;
}

/** The controls a work API caller may ask about. */
export type WorkControlName = "steer" | "interrupt" | "stop" | "pause" | "resume";

/** The controls the work channel performs, as every submission and status reports them. */
export const WORK_CONTROLS: Readonly<Record<WorkControlName, WorkControl>> = {
  interrupt: {
    description:
      "Cancels the running attempt. The streaming model call is aborted, and running tool calls receive an aborted signal; sandbox commands are killed. Effects a tool already caused are not undone. The work stays open for the next message.",
    preemptsModelStep: true,
    preemptsToolStep: "abort-signal",
    supported: true,
  },
  pause: {
    description:
      "Not supported: eve cannot suspend an attempt and continue it later from the same point. Use interrupt, then send a message to start a new attempt.",
    preemptsModelStep: false,
    preemptsToolStep: "no",
    supported: false,
  },
  resume: {
    description:
      "Not supported: there is no paused attempt to resume. An interrupted attempt is not retried; a new message starts the next attempt with the conversation so far.",
    preemptsModelStep: false,
    preemptsToolStep: "no",
    supported: false,
  },
  steer: {
    description:
      "Delivers a message to the running attempt. It never aborts a model call; the model reads it at its next step. It ends waits in workflow tools through their abort signal.",
    preemptsModelStep: false,
    preemptsToolStep: "abort-signal",
    supported: true,
  },
  stop: {
    description:
      "Cancels the running attempt like interrupt, then ends the work permanently. Its record stays readable.",
    preemptsModelStep: true,
    preemptsToolStep: "abort-signal",
    supported: true,
  },
};

/** The state of a piece of work, folded from its session stream. `cursor` is the next stream line. */
export interface WorkStatus {
  readonly version: 1;
  readonly sessionId: string;
  readonly status: WorkState;
  readonly attempt: WorkAttempt | null;
  readonly attempts: number;
  readonly reply: string | null;
  readonly error: ErrorInfo | null;
  readonly runner: RuntimeIdentity | null;
  readonly cursor: number;
  readonly controls: Readonly<Record<WorkControlName, WorkControl>>;
}

/** The latest finished attempt of a piece of work. */
export interface WorkResult {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcome: WorkAttemptOutcome;
  readonly reply: string | null;
  readonly error: ErrorInfo | null;
  readonly runner: RuntimeIdentity | null;
}

export function projectWorkStatus(view: SessionView, sessionId: string): WorkStatus {
  const all = Object.values(view.turns).sort((a, b) => a.introducedAt - b.introducedAt);
  const latest = all.at(-1);
  const observed = view.session;
  const attempt: WorkAttempt | null =
    latest === undefined
      ? null
      : {
          turnId: latest.turnId,
          status: latest.status,
          ...(latest.outcome !== undefined && { outcome: latest.outcome }),
          startedAt: latest.startedAt,
          ...(latest.endedAt !== undefined && { endedAt: latest.endedAt }),
        };
  return {
    attempt,
    attempts: all.length,
    controls: WORK_CONTROLS,
    cursor: view.position,
    error: latest?.error ?? observed.error ?? null,
    reply: latest === undefined ? null : (replyText(view, latest.turnId) ?? null),
    runner: observed.runtime ?? null,
    sessionId,
    status: workState(view, observed.status, latest),
    version: 1,
  };
}

function workState(
  view: SessionView,
  sessionStatus: "new" | "open" | "ended",
  latest: TurnRow | undefined,
): WorkState {
  if (sessionStatus === "ended") return "ended";
  if (latest === undefined || (latest.status === "settled" && queue(view).length > 0)) {
    return "queued";
  }
  if (latest.status === "running") {
    return waiting(view, latest.turnId)?.on === "interaction" ? "awaiting-input" : "running";
  }
  return latest.outcome ?? "completed";
}

export function workResultOf(status: WorkStatus): WorkResult | undefined {
  const { attempt } = status;
  if (attempt === null || attempt.status !== "settled" || attempt.outcome === undefined) {
    return undefined;
  }
  return {
    error: status.error,
    outcome: attempt.outcome,
    reply: status.reply,
    runner: status.runner,
    sessionId: status.sessionId,
    turnId: attempt.turnId,
    version: 1,
  };
}

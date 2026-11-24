import type { ToolSet, TypedToolCall } from "ai";

import { holdTurn as heldTurn } from "#harness/session-machine/transitions.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { activeTurnId, type HeldToolCall } from "#harness/session-machine/view.js";
import type {
  ControlHold,
  HarnessSession,
  HarnessToolLookup,
  SessionStateMap,
  StepResult,
} from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { AgentControlBoundary, AgentControlCheckpoint } from "#shared/agent-definition.js";
import type { Step } from "./context.js";

const log = createLogger("harness.control");

const CONTROL_HOLD_STATE_KEY = "eve.harness.controlHold";

const CHECKPOINT_FAILED = "The agent's control checkpoint failed.";

interface RecordedHold extends ControlHold {
  readonly turnId: string;
}

export async function askControl(
  step: Step,
  boundary: AgentControlBoundary,
): Promise<AgentControlCheckpoint> {
  const control = step.config.agentControl;
  if (control === undefined) return { instructions: [], proceed: true };
  const turnId = activeTurnId(step.position());
  try {
    const answer = await control.checkpoint({
      boundary,
      sessionId: step.session.sessionId,
      turnId,
    });
    if (typeof answer?.proceed !== "boolean" || !Array.isArray(answer.instructions)) {
      throw new TypeError("control.checkpoint() must return { proceed, instructions }.");
    }
    return answer;
  } catch (error) {
    logError(log, "agent control checkpoint failed", error, {
      boundary,
      sessionId: step.session.sessionId,
      turnId,
    });
    return { instructions: [], proceed: false, reason: CHECKPOINT_FAILED };
  }
}

export async function holdTurn(
  step: Step,
  boundary: AgentControlBoundary,
  reason: string | undefined,
): Promise<StepResult> {
  const turnId = activeTurnId(step.position());
  const hold: ControlHold = reason === undefined ? { boundary } : { boundary, reason };
  const recorded = recordedHold(step.session.state);
  if (recorded?.turnId !== turnId || recorded.boundary !== boundary || recorded.reason !== reason) {
    await step.apply(heldTurn(step.view(), { ...hold, turnId }));
    step.session = withHold(step.session, { ...hold, turnId });
  }
  return { held: { kind: "control", ...hold }, next: null, session: step.session };
}

export async function holdStepCalls(
  step: Step,
  input: {
    readonly excludedCallIds: ReadonlySet<string>;
    readonly stepResult: HarnessStepResult;
    readonly tools: HarnessToolLookup;
  },
): Promise<HarnessStepResult["controlHold"]> {
  if (step.config.agentControl === undefined) return undefined;
  const { finishReason, text } = input.stepResult;
  if (finishReason !== "stop" && finishReason !== "tool-calls") return undefined;
  const toolCalls = (input.stepResult.toolCalls ?? []) as TypedToolCall<ToolSet>[];
  const starts = toolCalls.some(
    (call) =>
      call.toolName !== REPLY_TOOL_NAME &&
      call.providerExecuted !== true &&
      !isInvalidToolCall(call) &&
      !input.excludedCallIds.has(call.toolCallId) &&
      input.tools.get(call.toolName) !== undefined,
  );
  if (!starts) return undefined;
  const answer = await askControl(step, "tools");
  if (answer.proceed) {
    step.session = releaseHold(step.session);
    return undefined;
  }
  return {
    calls: {
      excludedCallIds: [...input.excludedCallIds],
      finishReason,
      text,
      toolCalls: toolCalls.map(heldToolCall),
    },
    ...(answer.reason !== undefined && { reason: answer.reason }),
  };
}

function heldToolCall(call: TypedToolCall<ToolSet>): HeldToolCall {
  return {
    input: call.input,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    type: "tool-call",
    ...(call.providerExecuted === true && { providerExecuted: true }),
    ...(call.invalid === true && { invalid: true }),
    ...(call.dynamic === true && { dynamic: true }),
  };
}

export function releaseHold(session: HarnessSession): HarnessSession {
  if (session.state?.[CONTROL_HOLD_STATE_KEY] === undefined) return session;
  const { [CONTROL_HOLD_STATE_KEY]: _hold, ...state } = session.state;
  return { ...session, state };
}

function recordedHold(state: SessionStateMap | undefined): RecordedHold | undefined {
  return state?.[CONTROL_HOLD_STATE_KEY] as RecordedHold | undefined;
}

function withHold(session: HarnessSession, hold: RecordedHold): HarnessSession {
  return { ...session, state: { ...session.state, [CONTROL_HOLD_STATE_KEY]: hold } };
}

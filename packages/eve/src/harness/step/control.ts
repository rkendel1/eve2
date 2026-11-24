import type { ToolSet, TypedToolCall } from "ai";

import { stepCatalog } from "#definitions/step.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import { humanInputContext } from "#harness/hitl/index.js";
import { anchorToTurn, createUserMessage } from "#harness/messages.js";
import { withCallResults } from "#harness/model-call/response.js";
import { endsTurnTools } from "#harness/model-call/tools.js";
import { deliverUpdates, releaseHeldCalls } from "#harness/session-machine/transitions.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { StepResult } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { AgentControlInstruction } from "#shared/agent-definition.js";
import { settleStepResult } from "./after-model.js";
import type { Step } from "./context.js";
import { askControl, holdTurn, releaseHold } from "./control-hold.js";
import type { TurnInput } from "./intake.js";

const log = createLogger("harness.control");

export type ModelGate =
  | { readonly held: StepResult }
  | {
      readonly turn: TurnInput;
      readonly delivered: readonly AgentControlInstruction[];
      readonly runsBefore: ReadonlySet<string>;
    };

export async function passModelBoundary(step: Step, turn: TurnInput): Promise<ModelGate> {
  const runsBefore = new Set(Object.keys(step.view().projection.view.runs));
  if (step.config.agentControl === undefined) return { delivered: [], runsBefore, turn };
  const answer = await askControl(step, "model");
  if (!answer.proceed) return { held: await holdTurn(step, "model", answer.reason) };
  step.session = releaseHold(step.session);
  const deliveries = step.view().projection.view.deliveries;
  const fresh = [
    ...new Map(
      answer.instructions.map((instruction) => [instruction.instructionId, instruction]),
    ).values(),
  ].filter((instruction) => deliveries[instructionDeliveryId(instruction)] === undefined);
  if (fresh.length === 0) return { delivered: answer.instructions, runsBefore, turn };
  await step.apply(
    deliverUpdates(step.view(), {
      turnId: turn.turnId,
      updates: fresh.map((instruction) => ({
        deliveryId: instructionDeliveryId(instruction),
        text: updateText(instruction),
      })),
    }),
  );
  const messages = fresh.map((instruction) =>
    anchorToTurn(createUserMessage("user", updateText(instruction)), turn.turnId),
  );
  return {
    delivered: answer.instructions,
    runsBefore,
    turn: { ...turn, hasUserMessage: true, messages: [...turn.messages, ...messages] },
  };
}

export async function acknowledgeInstructions(
  step: Step,
  gate: Exclude<ModelGate, { readonly held: StepResult }>,
): Promise<void> {
  const control = step.config.agentControl;
  if (control === undefined || gate.delivered.length === 0) return;
  const run = Object.values(step.view().projection.view.runs)
    .filter((row) => !gate.runsBefore.has(row.runId))
    .at(-1);
  if (run?.status !== "settled" || run.outcome !== "completed") return;
  const { turnId } = gate.turn;
  for (const { instructionId } of gate.delivered) {
    try {
      await control.acknowledge({
        instructionId,
        note: `Given to the agent at model step ${run.runId} of turn ${turnId}.`,
        outcome: "incorporated",
        sessionId: step.session.sessionId,
      });
    } catch (error) {
      logError(log, "agent control acknowledge failed", error, {
        instructionId,
        sessionId: step.session.sessionId,
      });
    }
  }
}

export async function passToolsBoundary(step: Step): Promise<StepResult | undefined> {
  const parked = step.view().turn.suspended.find((suspended) => suspended.held !== undefined);
  if (parked?.held === undefined) return undefined;
  const answer = await askControl(step, "tools");
  if (!answer.proceed) return await holdTurn(step, "tools", answer.reason);
  step.session = releaseHold(step.session);
  await step.apply(releaseHeldCalls(step.view()));
  const { excludedCallIds, finishReason, text, toolCalls } = parked.held;
  const catalog = await stepCatalog(step);
  const excluded = new Set(excludedCallIds);
  const calls = [...toolCalls] as TypedToolCall<ToolSet>[];
  const executed = await executeInlineCalls({
    abortSignal: step.config.abortSignal,
    approvalMemory: humanInputContext(step).approvalMemory,
    beforeExecute: () => {},
    excludedCallIds: excluded,
    messages: [...step.session.history, ...parked.messages],
    publish: step.publish,
    toolCalls: calls,
    tools: catalog,
  });
  const stepResult = {
    content: [],
    finishReason,
    providerMetadata: undefined,
    response: { messages: parked.messages } as HarnessStepResult["response"],
    text,
    toolCalls: calls,
    toolResults: [],
    usage: UNMEASURED,
  } as HarnessStepResult;
  return await settleStepResult(step, {
    catalog,
    endsTurnTools: endsTurnTools(catalog, step.endsTurn),
    promptMessages: step.session.history,
    result: withCallResults({
      answers: [],
      calls: executed,
      invalidInputToolCallIds: excluded,
      responseMessages: parked.messages as HarnessStepResult["response"]["messages"],
      stepResult,
    }),
  });
}

const UNMEASURED: HarnessStepResult["usage"] = {
  inputTokenDetails: {
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    noCacheTokens: undefined,
  },
  inputTokens: undefined,
  outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
  outputTokens: undefined,
  totalTokens: undefined,
};

function instructionDeliveryId({ instructionId }: AgentControlInstruction): string {
  return `instruction:${instructionId}`;
}

function updateText({ from, text }: AgentControlInstruction): string {
  return `Update from ${from}: ${text}`;
}

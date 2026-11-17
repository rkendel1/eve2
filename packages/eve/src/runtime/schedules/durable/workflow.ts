import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  fireWorkflowScheduleStep,
  nextWorkflowScheduleOccurrenceStep,
  reportWorkflowScheduleFailureStep,
  startWorkflowScheduleVersionStep,
} from "#runtime/schedules/durable/steps.js";
import type {
  WorkflowScheduleMessage,
  WorkflowScheduleVersion,
} from "#runtime/schedules/durable/types.js";

export async function workflowScheduleWorkflow(version: WorkflowScheduleVersion): Promise<void> {
  "use workflow";
  const { serializedContext: _serializedContext, ...metadata } = version;
  const hook = createHook<WorkflowScheduleMessage>({
    token: version.token,
    metadata: JSON.parse(JSON.stringify(metadata)) as HookOptions["metadata"],
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }
  const { record } = version;
  let lastScheduledAt = version.lastScheduledAt;
  while (true) {
    const next =
      record.state === "active"
        ? await nextWorkflowScheduleOccurrenceStep({
            after: lastScheduledAt ?? new Date(record.updatedAt).toISOString(),
            expression: record.expression,
          })
        : null;
    if (record.state === "active" && next === null) {
      await disposeHook(hook);
      await startWorkflowScheduleVersionStep({
        ...version,
        lastScheduledAt,
        record: {
          ...record,
          state: "completed",
          updatedAt: lastScheduledAt === undefined ? record.updatedAt : Date.parse(lastScheduledAt),
        },
      });
      return;
    }
    const message = await (next === null ? hook : Promise.race([hook, sleep(new Date(next))]));
    if (message === undefined && next !== null) {
      try {
        await fireWorkflowScheduleStep({ scheduledAt: next, version });
      } catch (error) {
        await reportWorkflowScheduleFailureStep({
          reason: error instanceof Error ? error.message : "Scheduled occurrence failed.",
          scheduledAt: next,
          version,
        });
      }
      lastScheduledAt = next;
      continue;
    }
    await disposeHook(hook);
    if (message?.kind === "replace") await startWorkflowScheduleVersionStep(message.version);
    return;
  }
}

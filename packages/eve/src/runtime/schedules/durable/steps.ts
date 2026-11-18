import { deserializeContext } from "#context/serialize.js";
import {
  createWorkflowRuntime,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import { workflowScheduleWorkflowReference } from "#execution/workflow-references.js";
import type { ScheduleExpression } from "#public/schedules/subscription.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import {
  nextDueScheduleOccurrence,
  WORKFLOW_SCHEDULE_PROVIDER_KIND,
} from "#runtime/schedules/durable/state.js";
import type { WorkflowScheduleVersion } from "#runtime/schedules/durable/types.js";
import { requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

export async function nextWorkflowScheduleOccurrenceStep(input: {
  readonly after: string;
  readonly expression: ScheduleExpression;
}): Promise<string | null> {
  "use step";
  return (
    nextDueScheduleOccurrence(input.expression, new Date(input.after), new Date())?.toISOString() ??
    null
  );
}

export async function startWorkflowScheduleVersionStep(
  version: WorkflowScheduleVersion,
): Promise<void> {
  "use step";
  await startWorkflowOnCurrentDeployment(workflowScheduleWorkflowReference, [version]);
}

export async function fireWorkflowScheduleStep(input: {
  readonly scheduledAt: string;
  readonly version: WorkflowScheduleVersion;
}): Promise<void> {
  "use step";
  const { version } = input;
  const target = await loadScheduleTarget(version);
  await dispatchScheduledOccurrence({
    bundle: target.bundle,
    collection: version.collection,
    definition: target.definition,
    namespace: version.namespace,
    occurrence: {
      collection: version.collection,
      executionId: `${version.record.scheduleId}:${input.scheduledAt}`,
      name: version.record.name,
      scheduleId: version.record.scheduleId,
      scheduledAt: input.scheduledAt,
    },
    payload: parseSchedulePayload<unknown>(version.payload, {
      application: target.application,
      collection: version.collection,
    }),
    runtime: createWorkflowRuntime({
      compiledArtifactsSource: target.bundle.compiledArtifactsSource,
    }),
  });
}

export async function reportWorkflowScheduleFailureStep(input: {
  readonly reason: string;
  readonly scheduledAt: string;
  readonly version: WorkflowScheduleVersion;
}): Promise<void> {
  "use step";
  const { version } = input;
  const { definition } = await loadScheduleTarget(version);
  const occurrence = {
    collection: version.collection,
    executionId: `${version.record.scheduleId}:${input.scheduledAt}`,
    name: version.record.name,
    scheduleId: version.record.scheduleId,
    scheduledAt: input.scheduledAt,
  };
  await definition.events?.["occurrence.failed"]?.({
    ...occurrence,
    occurrence,
    reason: input.reason,
    type: "occurrence.failed",
  });
}

async function loadScheduleTarget(version: WorkflowScheduleVersion) {
  const ctx = await deserializeContext(version.serializedContext);
  const bundle = requireCompiledBundle(ctx);
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: bundle.compiledArtifactsSource,
  });
  const definition = await loadScheduleCollectionDefinition(bundle, version.collection, {
    manifest,
    providerKind: WORKFLOW_SCHEDULE_PROVIDER_KIND,
  });
  return { application: manifest.config.name, bundle, definition };
}

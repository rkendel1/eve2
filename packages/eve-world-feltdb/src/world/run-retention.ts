/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/run-retention.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { Event, Hook } from "@workflow/world";
import { getEventDataRefFields, RETENTION_ATTRIBUTE, readRunRetention } from "@workflow/world";
import type { Store } from "./store.js";
export function purgesUserDataOnFinish(attributes: Record<string, string> | undefined): boolean {
  const retention = readRunRetention(attributes);
  if (retention.unsupported) {
    console.warn(
      `[world-feltdb] Ignoring unrecognized ${RETENTION_ATTRIBUTE} value ` +
        `${JSON.stringify(retention.raw)}; keeping the run's data.`,
    );
  }
  return retention.mode === "none";
}
export async function purgeRunData(store: Store, runId: string): Promise<void> {
  for (const record of await store.listStepRecords(runId)) {
    const step = await store.stepFrom(record);
    step.input = undefined as never;
    step.output = undefined;
    step.error = undefined;
    await store.updateStep(step);
  }
  for (const stored of await store.eventsOfRun(runId)) {
    const event = stored as Event & {
      eventData?: Record<string, unknown>;
    };
    const eventData = event.eventData;
    if (!eventData || typeof eventData !== "object") continue;
    for (const field of getEventDataRefFields(String(event.eventType))) {
      delete eventData[field];
    }
    if (event.eventType === "run_created" || event.eventType === "run_started") {
      delete eventData.dynamicWorkflowCode;
      delete eventData.dynamicWorkflowCodeRef;
      const startHook = eventData.startHook as Record<string, unknown> | undefined;
      if (startHook && typeof startHook === "object") delete startHook.metadata;
    }
    await store.rewriteEvent(event);
  }
  for (const hookId of await store.hookIdsOfRun(runId)) {
    const hook: Hook | null = await store.getHook(hookId);
    if (!hook) continue;
    hook.metadata = undefined;
    await store.rewriteHook(hook);
  }
  await purgeRunStreams(store, runId);
}
export async function purgeRunStreams(store: Store, runId: string): Promise<void> {
  await store.purgeRunStreams(runId);
}

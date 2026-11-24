/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/start-hook.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type { Event, Hook, HookCreatedEvent, StartHook, WorkflowRun } from "@workflow/world";
import { startHookId } from "@workflow/world";
export function withStartHookId(startHook: StartHook, runId: string): StartHook {
  return { ...startHook, hookId: startHookId(runId) };
}
export function startHookRecord(run: WorkflowRun): Hook | null {
  const startHook = run.startHook;
  if (!startHook) return null;
  return {
    runId: run.runId,
    hookId: startHookId(run.runId),
    token: startHook.token,
    metadata: startHook.metadata,
    ownerId: "local-owner",
    projectId: "local-project",
    environment: "local",
    createdAt: run.createdAt,
    specVersion: run.specVersion,
    isWebhook: false,
    isSystem: false,
    tokenRetentionUntil: startHook.tokenRetentionUntil,
  };
}
export function hookCreatedFromRunCreated(event: Event): HookCreatedEvent | null {
  if (event.eventType !== "run_created") return null;
  const startHook = (
    event.eventData as
      | {
          startHook?: StartHook;
        }
      | undefined
  )?.startHook;
  if (!startHook || typeof startHook.token !== "string") return null;
  return {
    eventType: "hook_created",
    runId: event.runId,
    eventId: event.eventId,
    correlationId: startHookId(event.runId),
    createdAt: event.createdAt,
    specVersion: event.specVersion,
    eventData: {
      token: startHook.token,
      metadata: startHook.metadata,
      tokenRetentionUntil: startHook.tokenRetentionUntil,
      isWebhook: false,
    },
  } as HookCreatedEvent;
}
export function runIdOfStartHookId(hookId: string): string | null {
  if (!hookId.startsWith("hook_") || hookId.length <= "hook_".length) {
    return null;
  }
  return `wrun_${hookId.slice("hook_".length)}`;
}

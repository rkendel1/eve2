/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/events-storage.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { createHash } from "node:crypto";
import {
  EntityConflictError,
  HookConflictError,
  HookForceClaimedError,
  HookNotFoundError,
  InBandSupersededError,
  RunExpiredError,
  RunNotSupportedError,
  START_HOOK_ADMISSION_REJECTED,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from "@workflow/errors";
import { debugLog } from "@workflow/utils";
import type {
  AnyEventRequest,
  CreateEventParams,
  Event,
  EventResult,
  EventsResolveData,
  Hook,
  HookCreatedEventRequest,
  PaginatedResponse,
  SerializedData,
  StartHook,
  StartHookRejectionReason,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from "@workflow/world";
import {
  applyAttributeChanges,
  getEventDataRefFields,
  getMaxEventsForRun,
  getMaxEventsPerRun,
  IN_BAND_SEQ_AT_RUN_CREATION,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isStartHookId,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  slotToEventId,
  stripEventDataRefs,
  ulidToDate,
  validateAttributeChanges,
  validateUlidTimestamp,
} from "@workflow/world";
import { monotonicFactory } from "ulid";
import { DEFAULT_RESOLVE_DATA_OPTION } from "./config.js";
import { CommitThenThrow, type WorldDatabase } from "./database.js";
import { assertSafeEntityId } from "./ids.js";
import { purgeRunData, purgesUserDataOnFinish } from "./run-retention.js";
import { signalRunTerminal } from "./run-status-signal.js";
import { startHookRecord, withStartHookId } from "./start-hook.js";
import { eventCursor, type RunRow, Store } from "./store.js";
const DAY_MS = 24 * 60 * 60 * 1000;
const monotonicUlid = monotonicFactory();
function getHookRetentionLimitMs(): number {
  const days = Number(process.env.WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkflowWorldError(
      "WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS must be a positive number",
      { status: 400 },
    );
  }
  return days * DAY_MS;
}
function startHookLog(message: string, detail: Record<string, string>): void {
  debugLog(`[world-local] start Hook: ${message}`, detail);
}
function startHookRejected(message: string, reason: StartHookRejectionReason): WorkflowWorldError {
  return new WorkflowWorldError(message, {
    status: 400,
    code: START_HOOK_ADMISSION_REJECTED,
    reason,
  });
}
const MAX_EVENT_PAGE_BYTES = 8 * 1024 * 1024;
class RecordedRefusal extends Error {
  readonly refusal: unknown;
  constructor(refusal: unknown) {
    super("recorded refusal");
    this.refusal = refusal;
  }
}
type Resolve = EventsResolveData;
type RunCreationData = {
  deploymentId: string;
  workflowName: string;
  input: SerializedData;
  executionContext?: Record<string, any>;
  attributes?: Record<string, string>;
  allowReservedAttributes?: true;
  encryptionPublicKey?: string;
  dynamicWorkflowCode?: SerializedData;
  startHook?: StartHook;
};
export type LocalEventsStorage = Storage["events"] & {
  clearCache(): void;
};
export function createEventsStorage(database: WorldDatabase, tag?: string): LocalEventsStorage {
  const reader = new Store(database, tag);
  const hookRetentionLimitMs = getHookRetentionLimitMs();
  const resolveOf = (params?: CreateEventParams): Resolve =>
    params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  function inTransaction(store: Store) {
    async function isTokenReleasable(owner: {
      hookId: string;
      runId: string;
      retentionUntil: number | null;
    }): Promise<boolean> {
      if (await store.getDisposal(owner.hookId)) return true;
      const ownerRun = await store.getRunAnyTag(owner.runId);
      if (!ownerRun) return true;
      if (!isTerminalWorkflowRunStatus(ownerRun.run.status)) return false;
      return owner.retentionUntil === null || owner.retentionUntil <= Date.now();
    }
    async function releaseOwner(
      token: string,
      owner: {
        hookId: string;
      },
    ): Promise<void> {
      await store.releaseToken(token, owner.hookId);
      const hook = await store.getHook(owner.hookId);
      if (hook && hook.token === token) store.deleteHook(owner.hookId);
    }
    async function releaseRunResources(runId: string): Promise<void> {
      const now = Date.now();
      for (const hookId of await store.hookIdsOfRun(runId)) {
        const hook = await store.getHook(hookId);
        if (!hook) continue;
        if (hook.tokenRetentionUntil && new Date(hook.tokenRetentionUntil).getTime() > now) {
          continue;
        }
        await store.releaseToken(hook.token, hook.hookId);
        store.deleteHook(hook.hookId);
      }
      await store.deleteWaitsOfRun(runId);
    }
    type Admission =
      | {
          status: "created";
        }
      | {
          status: "existing";
          run: RunRow;
        };
    async function admitStartHook(
      runId: string,
      startHook: StartHook,
      writeRun: () => Promise<void>,
    ): Promise<Admission> {
      const rejection = await store.getStartHookRejection(runId);
      if (rejection) {
        if (rejection.token !== startHook.token) {
          throw startHookRejected(
            `Workflow run "${runId}" was already decided for a different start Hook token`,
            "token_mismatch",
          );
        }
        throw new HookConflictError(rejection.token, rejection.conflictingRunId);
      }
      const existing = await store.getRun(runId);
      if (existing) {
        if (existing.run.startHook?.token !== startHook.token) {
          throw startHookRejected(
            `Workflow run "${runId}" already exists without this start Hook`,
            "ordinary_run",
          );
        }
        return { status: "existing", run: existing };
      }
      const candidateTime = ulidToDate(runId.replace(/^wrun_/, ""));
      if (candidateTime && Date.now() - candidateTime.getTime() > START_HOOK_CANDIDATE_MAX_AGE_MS) {
        throw startHookRejected(
          `Workflow run "${runId}" is too old to be admitted with a start Hook`,
          "expired",
        );
      }
      const owner = await store.getTokenOwner(startHook.token);
      if (owner) {
        if (!(await isTokenReleasable(owner))) {
          await store.insertStartHookRejection(runId, startHook.token, owner.runId);
          startHookLog("refused a candidate", {
            runId,
            conflictingRunId: owner.runId,
          });
          throw new RecordedRefusal(new HookConflictError(startHook.token, owner.runId));
        }
        startHookLog("released an ended owner's token to a candidate", {
          runId,
          previousRunId: owner.runId,
        });
        await releaseOwner(startHook.token, owner);
      }
      await writeRun();
      startHookLog("accepted a candidate", { runId });
      return { status: "created" };
    }
    function writeStartHook(run: WorkflowRun): void {
      const hook = startHookRecord(run);
      if (!hook) return;
      store.setTokenOwner(hook.token, hook.hookId, run.runId, hook.tokenRetentionUntil);
      store.upsertHook(hook);
    }
    async function page(
      runId: string,
      options: {
        cursor?: string;
        limit?: number;
      },
      resolveData: Resolve,
    ): Promise<{
      events: Event[];
      cursor: string | null;
      hasMore: boolean;
    }> {
      const result = await store.listEvents(runId, { ...options, sortOrder: "asc" });
      return {
        events:
          resolveData === "all"
            ? result.data
            : result.data.map((event) => stripEventDataRefs(event, resolveData)),
        cursor: result.cursor,
        hasMore: result.hasMore,
      };
    }
    async function createInTransaction(
      runIdArg: string | null,
      data: AnyEventRequest,
      params: CreateEventParams | undefined,
      effects: Array<() => void>,
    ): Promise<EventResult> {
      const now =
        params?.inBand === true && params.occurredAt ? new Date(params.occurredAt) : new Date();
      let runId: string;
      if (data.eventType === "run_created" && (!runIdArg || runIdArg === "")) {
        runId = `wrun_${monotonicUlid()}`;
      } else if (!runIdArg) {
        throw new Error("runId is required for non-run_created events");
      } else {
        runId = runIdArg;
      }
      if (data.eventType === "run_created" && runIdArg) {
        const validationError = validateUlidTimestamp(runId, "wrun_");
        if (validationError) {
          throw new WorkflowWorldError(validationError, {
            ...(data.eventData.startHook
              ? {
                  status: 400,
                  code: START_HOOK_ADMISSION_REJECTED,
                  reason: "expired",
                }
              : {}),
          });
        }
      }
      const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
      const resolveData = resolveOf(params);
      const skipsRunValidation =
        data.eventType === "step_completed" || data.eventType === "step_retrying";
      let current: RunRow | null =
        data.eventType === "run_created" || skipsRunValidation ? null : await store.getRun(runId);
      let stepCreatedLazily = false;
      if (data.eventType === "run_started" && !current && data.eventData) {
        const seed = data.eventData as Partial<RunCreationData>;
        if (seed.deploymentId && seed.workflowName && seed.input !== undefined) {
          validateAttributeChanges(
            Object.entries(seed.attributes ?? {}).map(([key, value]) => ({
              key,
              value,
            })),
            { allowReservedAttributes: seed.allowReservedAttributes === true },
          );
          const created = buildRun(runId, seed as RunCreationData, specVersion, now);
          const writeRun = async () => {
            store.insertRun(created);
            writeStartHook(created);
            await store.appendEvent(runCreatedEvent(created, seed as RunCreationData, now));
          };
          if (seed.startHook) {
            await admitStartHook(runId, seed.startHook, writeRun);
          } else {
            await writeRun();
          }
          current = await store.getRun(runId);
        }
      }
      if (
        !current &&
        (data.eventType === "run_failed" ||
          data.eventType === "attr_set" ||
          data.eventType === "run_started" ||
          data.eventType === "run_cancelled")
      ) {
        throw new WorkflowRunNotFoundError(runId);
      }
      const run = current?.run ?? null;
      if (run && requiresNewerWorld(run.specVersion)) {
        throw new RunNotSupportedError(run.specVersion!, SPEC_VERSION_MAX_SUPPORTED);
      }
      const createsChildEntity = isChildEntityCreationEvent(data);
      const lazyStepStart = createsChildEntity && data.eventType === "step_started";
      const creationOnStart = () =>
        lazyStepStart && (run?.specVersion ?? 0) >= SPEC_VERSION_SINGLE_ORCHESTRATOR;
      if (run && isTerminalWorkflowRunStatus(run.status)) {
        if (data.eventType === "run_cancelled" && run.status === "cancelled") {
          const stored = await store.appendEvent({
            ...data,
            runId,
            createdAt: now,
            specVersion,
          } as Event);
          return {
            event: stripEventDataRefs(stored, resolveData),
            run,
            maxEvents: getMaxEventsForRun(run),
          };
        }
        if (data.eventType === "run_started") {
          throw new RunExpiredError(
            `Workflow run "${runId}" is already in terminal state "${run.status}"`,
          );
        }
        if (isTerminalRunEventType(data.eventType)) {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${run.status}"`,
          );
        }
        if (createsChildEntity) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${run.status}"`,
          );
        }
        if (data.eventType === "attr_set") {
          throw new EntityConflictError(
            `Cannot set attributes on run in terminal state "${run.status}"`,
          );
        }
      }
      let validatedStep: Step | null = null;
      if (
        isStepEventType(data.eventType) &&
        data.eventType !== "step_created" &&
        data.correlationId
      ) {
        validatedStep = await store.getStep(runId, data.correlationId);
        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`);
        }
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(`Step "${data.correlationId}" already created`);
        }
        if (validatedStep) {
          if (isTerminalStepStatus(validatedStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${validatedStep.status}"`,
            );
          }
          if (run && isTerminalWorkflowRunStatus(run.status)) {
            if (validatedStep.status !== "running" || data.eventType === "step_started") {
              throw new RunExpiredError(
                `Cannot ${data.eventType === "step_started" ? "start" : "modify non-running"} step on run in terminal state "${run.status}"`,
              );
            }
          }
        }
      }
      let existingHook: Hook | null = null;
      if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
        const hookId = data.correlationId;
        if (data.eventType === "hook_received" && params?.resumeId) {
          const committed = await committedResume(runId, params.resumeId);
          if (committed) {
            if (committed.hookId !== hookId) {
              throw new EntityConflictError(
                `hook_received resumeId "${params.resumeId}" already recorded for a different hook`,
              );
            }
            if (
              params.resumePayloadDigest &&
              committed.payloadDigest &&
              committed.payloadDigest !== params.resumePayloadDigest
            ) {
              throw new EntityConflictError(
                `hook_received resumeId "${params.resumeId}" already recorded with a different payload`,
              );
            }
            return { event: stripEventDataRefs(committed.event, resolveData) };
          }
        }
        if (data.eventType === "hook_received") {
          await refuseDisposedHookDelivery(
            hookId,
            (
              data.eventData as
                | {
                    token?: unknown;
                  }
                | undefined
            )?.token,
          );
        }
        existingHook = await store.getHook(hookId);
        if (!existingHook || existingHook.runId !== runId) {
          throw new HookNotFoundError(hookId);
        }
        if (data.eventType === "hook_received") {
          if (!run) throw new WorkflowRunNotFoundError(runId);
          if (isTerminalWorkflowRunStatus(run.status)) {
            throw new RunExpiredError(`Workflow run "${runId}" is already in a terminal state`);
          }
        }
      }
      let event = {
        ...data,
        runId,
        createdAt: now,
        specVersion,
        ...(data.eventType === "hook_received" && params?.resumeId
          ? { resumeId: params.resumeId }
          : {}),
      } as Event;
      if (data.eventType === "run_started" && "eventData" in event) {
        delete (
          event as {
            eventData?: unknown;
          }
        ).eventData;
      }
      if (event.eventType === "run_created" && event.eventData) {
        const {
          dynamicWorkflowCode: _code,
          dynamicWorkflowCodeRef: _ref,
          ...eventData
        } = event.eventData as Record<string, unknown>;
        if (eventData.startHook) {
          eventData.startHook = withStartHookId(eventData.startHook as StartHook, runId);
        }
        event = { ...event, eventData } as Event;
      }
      if (
        lazyStepStart &&
        !creationOnStart() &&
        event.eventType === "step_started" &&
        event.eventData
      ) {
        const { input: _input, ...eventData } = event.eventData as Record<string, unknown>;
        event = { ...event, eventData } as Event;
      }
      let resultRun: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;
      let runPurged = false;
      const lifecycle = async (next: WorkflowRun): Promise<WorkflowRun> => {
        const fresh = (await store.getRun(runId))?.run ?? next;
        let updated: WorkflowRun = { ...next, attributes: fresh.attributes };
        if (
          isTerminalWorkflowRunStatus(updated.status) &&
          purgesUserDataOnFinish(updated.attributes)
        ) {
          updated = withRunPayloadsPurged(updated, new Date());
          runPurged = true;
        }
        await store.updateRun(updated);
        if (isTerminalWorkflowRunStatus(updated.status)) {
          effects.push(() => signalRunTerminal(runId));
        }
        return updated;
      };
      switch (data.eventType) {
        case "run_created": {
          const runData = data.eventData as RunCreationData;
          validateAttributeChanges(
            Object.entries(runData.attributes ?? {}).map(([key, value]) => ({
              key,
              value,
            })),
            { allowReservedAttributes: runData.allowReservedAttributes === true },
          );
          const created = buildRun(runId, runData, specVersion, now);
          if (runData.startHook) {
            let committedEvent: Event | undefined;
            const admission = await admitStartHook(runId, runData.startHook, async () => {
              store.insertRun(created);
              writeStartHook(created);
              committedEvent = await store.appendEvent(event);
            });
            if (admission.status === "existing") {
              const first = await store.getEventAt(runId, 1);
              if (first?.eventType !== "run_created") {
                throw new WorkflowWorldError(
                  `Workflow run "${runId}" has no run_created at its first position`,
                );
              }
              return {
                event: stripEventDataRefs(first, resolveData),
                run: admission.run.run,
                maxEvents: getMaxEventsForRun(admission.run.run),
              };
            }
            return await finish(committedEvent!, created);
          }
          if (await store.runExistsAnyTag(runId)) {
            throw new EntityConflictError(`Workflow run "${runId}" already exists`);
          }
          store.insertRun(created);
          resultRun = created;
          break;
        }
        case "run_started": {
          if (run!.status === "running") {
            if (params?.skipPreload) {
              return { run: run!, maxEvents: getMaxEventsForRun(run!) };
            }
            const preload = await page(runId, { limit: getMaxEventsPerRun() }, resolveData);
            return {
              run: run!,
              ...preload,
              maxEvents: getMaxEventsForRun(run!),
            };
          }
          resultRun = await lifecycle({
            ...run!,
            status: "running",
            output: undefined,
            error: undefined,
            completedAt: undefined,
            startedAt: run!.startedAt ?? now,
            updatedAt: now,
          });
          break;
        }
        case "run_completed":
        case "run_failed":
        case "run_cancelled": {
          const terminalData = (
            data as {
              eventData?: Record<string, unknown>;
            }
          ).eventData;
          resultRun = await lifecycle({
            ...run!,
            status:
              data.eventType === "run_completed"
                ? "completed"
                : data.eventType === "run_failed"
                  ? "failed"
                  : "cancelled",
            output:
              data.eventType === "run_completed"
                ? (terminalData?.output as SerializedData)
                : undefined,
            error:
              data.eventType === "run_failed" ? (terminalData?.error as SerializedData) : undefined,
            ...(data.eventType === "run_failed"
              ? { errorCode: terminalData?.errorCode as string | undefined }
              : {}),
            completedAt: now,
            updatedAt: now,
          } as WorkflowRun);
          await releaseRunResources(runId);
          break;
        }
        case "attr_set": {
          const fresh = (await store.getRun(runId))!.run;
          validateAttributeChanges(data.eventData.changes, {
            existingKeys: Object.keys(fresh.attributes ?? {}),
            allowReservedAttributes: data.eventData.allowReservedAttributes === true,
          });
          if (data.correlationId && data.eventData.writer.type === "workflow") {
            if (await store.findEvent(runId, data.correlationId, "attr_set")) {
              throw new EntityConflictError(
                `Attribute event "${data.correlationId}" already exists`,
              );
            }
          }
          resultRun = {
            ...fresh,
            attributes: applyAttributeChanges(fresh.attributes, data.eventData.changes),
            updatedAt: now,
          };
          await store.updateRun(resultRun);
          break;
        }
        case "step_created": {
          if (await store.getStep(runId, data.correlationId)) {
            throw new EntityConflictError(`Step "${data.correlationId}" already created`);
          }
          const stepData = data.eventData as {
            stepName: string;
            input: any;
          };
          step = {
            runId,
            stepId: data.correlationId,
            stepName: stepData.stepName,
            status: "pending",
            input: stepData.input,
            output: undefined,
            error: undefined,
            attempt: 0,
            startedAt: undefined,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
            specVersion,
          };
          store.insertStep(step);
          break;
        }
        case "step_started": {
          if (!validatedStep && lazyStepStart) {
            const lazyData = data.eventData as {
              stepName: string;
              input: any;
            };
            validatedStep = {
              runId,
              stepId: data.correlationId,
              stepName: lazyData.stepName,
              status: "pending",
              input: lazyData.input,
              output: undefined,
              error: undefined,
              attempt: 0,
              startedAt: undefined,
              completedAt: undefined,
              createdAt: now,
              updatedAt: now,
              specVersion,
            };
            store.insertStep(validatedStep);
            if (!creationOnStart()) {
              await store.appendEvent({
                eventType: "step_created",
                runId,
                createdAt: now,
                specVersion,
                correlationId: data.correlationId,
                eventData: {
                  stepName: lazyData.stepName,
                  input: lazyData.input,
                },
              } as Event);
            }
            stepCreatedLazily = true;
          }
          if (validatedStep) {
            if (
              validatedStep.retryAfter &&
              new Date(validatedStep.retryAfter).getTime() > Date.now()
            ) {
              throw new TooEarlyError(
                `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
                {
                  retryAfter: Math.ceil(
                    (new Date(validatedStep.retryAfter).getTime() - Date.now()) / 1000,
                  ),
                },
              );
            }
            step = {
              ...validatedStep,
              status: "running",
              startedAt: validatedStep.startedAt ?? now,
              attempt: validatedStep.attempt + 1,
              retryAfter: undefined,
              updatedAt: now,
            };
            await store.updateStep(step);
          }
          break;
        }
        case "step_completed": {
          if (validatedStep) {
            step = {
              ...validatedStep,
              status: "completed",
              output: (
                data.eventData as {
                  result: any;
                }
              ).result,
              completedAt: now,
              updatedAt: now,
            };
            await store.updateStep(step);
          }
          break;
        }
        case "step_failed": {
          if (validatedStep) {
            step = {
              ...validatedStep,
              status: "failed",
              error: (
                data.eventData as {
                  error: unknown;
                }
              ).error as Uint8Array,
              completedAt: now,
              updatedAt: now,
            };
            await store.updateStep(step);
          }
          break;
        }
        case "step_retrying": {
          if (validatedStep) {
            const retryData = data.eventData as {
              error: unknown;
              retryAfter?: Date;
            };
            step = {
              ...validatedStep,
              status: "pending",
              error: retryData.error as Uint8Array,
              retryAfter: retryData.retryAfter,
              updatedAt: now,
            };
            await store.updateStep(step);
          }
          break;
        }
        case "hook_created": {
          const created = await createHook(runId, run, data, event, params, now);
          if (created.kind === "conflict") {
            const delta =
              typeof params?.sinceCursor === "string"
                ? await page(runId, { cursor: params.sinceCursor }, resolveData)
                : undefined;
            return {
              event: stripEventDataRefs(created.event, resolveData),
              run: undefined,
              step: undefined,
              hook: undefined,
              ...(delta ?? {}),
            } as EventResult;
          }
          event = created.event;
          hook = created.hook;
          break;
        }
        case "hook_disposed": {
          if (!(await store.insertDisposal(data.correlationId, runId))) {
            throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
          }
          if (existingHook) {
            await store.releaseToken(existingHook.token, existingHook.hookId);
          }
          store.deleteHook(data.correlationId);
          break;
        }
        case "wait_created": {
          if (await store.getWait(runId, data.correlationId)) {
            throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
          }
          wait = {
            waitId: `${runId}-${data.correlationId}`,
            runId,
            status: "waiting",
            resumeAt: (
              data.eventData as {
                resumeAt?: Date;
              }
            ).resumeAt,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
            specVersion,
          };
          store.insertWait(data.correlationId, wait);
          break;
        }
        case "wait_completed": {
          const existingWait = await store.getWait(runId, data.correlationId);
          if (!existingWait) {
            throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`);
          }
          if (existingWait.status === "completed") {
            throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
          }
          wait = {
            ...existingWait,
            status: "completed",
            completedAt: now,
            updatedAt: now,
          };
          store.updateWait(data.correlationId, wait);
          break;
        }
        default:
          break;
      }
      const stored = await store.appendEvent(event);
      if (data.eventType === "hook_received" && params?.resumeId) {
        const inserted = await store.insertHookResume(runId, params.resumeId, {
          hookId: data.correlationId,
          seq: Number(stored.eventId.slice("evnt_".length)),
          payloadDigest: params.resumePayloadDigest ?? null,
        });
        if (!inserted) {
          throw new EntityConflictError(
            `hook_received resumeId "${params.resumeId}" already recorded`,
          );
        }
      }
      if (runPurged) {
        await purgeRunData(store, runId);
      }
      return await finish(stored, resultRun, {
        step,
        hook,
        wait,
        stepCreatedLazily,
      });
      async function finish(
        committed: Event,
        finalRun: WorkflowRun | undefined,
        extra: {
          step?: Step;
          hook?: Hook;
          wait?: Wait;
          stepCreatedLazily?: boolean;
        } = {},
      ): Promise<EventResult> {
        let delta:
          | {
              events: Event[];
              cursor: string | null;
              hasMore: boolean;
            }
          | undefined;
        if (data.eventType === "run_started" && finalRun && !params?.skipPreload) {
          delta = await page(runId, { limit: getMaxEventsPerRun() }, resolveData);
        }
        if (typeof params?.sinceCursor === "string") {
          delta = await page(runId, { cursor: params.sinceCursor }, resolveData);
        }
        const reportRun = finalRun;
        const result: EventResult = {
          event: stripEventDataRefs(committed, resolveData),
          run: reportRun,
          step: extra.step,
          hook: extra.hook,
          wait: extra.wait,
          ...(reportRun ? { maxEvents: getMaxEventsForRun(reportRun) } : {}),
        };
        if (extra.stepCreatedLazily) result.stepCreated = true;
        return delta ? ({ ...result, ...delta } as EventResult) : result;
      }
    }
    async function committedResume(
      runId: string,
      resumeId: string,
    ): Promise<{
      hookId: string;
      payloadDigest: string | null;
      event: Event;
    } | null> {
      const row = await store.getHookResume(runId, resumeId);
      if (!row) return null;
      const event = await store.getEventAt(runId, row.seq);
      if (!event) return null;
      return { hookId: row.hookId, payloadDigest: row.payloadDigest, event };
    }
    async function refuseDisposedHookDelivery(hookId: string, token: unknown): Promise<void> {
      const disposal = await store.getDisposal(hookId);
      if (!disposal) return;
      if (disposal.forceClaimedBy) {
        const tokenString = typeof token === "string" ? token : "";
        const successor = tokenString ? await store.getTokenOwner(tokenString) : null;
        throw new HookForceClaimedError(
          tokenString,
          successor?.runId ?? disposal.forceClaimedBy.runId,
          successor?.hookId ?? disposal.forceClaimedBy.hookId,
        );
      }
      throw new HookNotFoundError(hookId);
    }
    type HookCreation =
      | {
          kind: "created";
          event: Event;
          hook: Hook;
        }
      | {
          kind: "conflict";
          event: Event;
        };
    async function createHook(
      runId: string,
      run: WorkflowRun | null,
      data: Extract<
        AnyEventRequest,
        {
          eventType: "hook_created";
        }
      >,
      event: Event,
      _params: CreateEventParams | undefined,
      now: Date,
    ): Promise<HookCreation> {
      const hookId = data.correlationId;
      const hookData = data.eventData as HookCreatedEventRequest["eventData"];
      const specVersion = event.specVersion;
      if (!run) throw new WorkflowRunNotFoundError(runId);
      if (
        (await store.getDisposal(hookId)) ||
        (await store.findEvent(runId, hookId, "hook_created"))
      ) {
        throw new EntityConflictError(`Hook "${hookId}" already created`);
      }
      let claimedFrom:
        | {
            runId: string;
            hookId: string;
            workflowName?: string;
            deploymentId?: string;
            runSpecVersion?: number;
          }
        | undefined;
      const owner = await store.getTokenOwner(hookData.token);
      if (owner) {
        if (owner.runId === runId && owner.hookId === hookId) {
          throw new EntityConflictError(`Hook "${hookId}" already created`);
        }
        if (!(await isTokenReleasable(owner))) {
          const conflict = async (forceRefusedReason?: "victim-spec-version") =>
            ({
              kind: "conflict",
              event: await store.appendEvent({
                eventType: "hook_conflict",
                correlationId: hookId,
                eventData: {
                  token: hookData.token,
                  conflictingRunId: owner.runId,
                  ...(forceRefusedReason !== undefined && { forceRefusedReason }),
                },
                runId,
                createdAt: now,
                specVersion,
              } as Event),
            }) as const;
          if (hookData.force !== true) return await conflict();
          const victim = await store.getRunAnyTag(owner.runId);
          const victimRunning = victim !== null && !isTerminalWorkflowRunStatus(victim.run.status);
          if (
            victimRunning &&
            (victim.run.specVersion ?? SPEC_VERSION_LEGACY) < SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
          ) {
            return await conflict("victim-spec-version");
          }
          claimedFrom = {
            runId: owner.runId,
            hookId: owner.hookId,
            ...(victimRunning && {
              workflowName: victim.run.workflowName,
              deploymentId: victim.run.deploymentId,
              runSpecVersion: victim.run.specVersion,
            }),
          };
          await store.insertDisposal(owner.hookId, owner.runId, { runId, hookId });
          if (victimRunning) {
            await store.appendEvent({
              eventType: "hook_disposed",
              correlationId: owner.hookId,
              eventData: {
                token: hookData.token,
                forceClaimedBy: { runId, hookId },
              },
              runId: owner.runId,
              createdAt: new Date(),
              specVersion: victim.run.specVersion,
            } as Event);
          }
          store.deleteHook(owner.hookId);
        } else {
          await releaseOwner(hookData.token, owner);
        }
      }
      const stored = claimedFrom
        ? ({
            ...event,
            eventData: {
              ...(event.eventData as Record<string, unknown>),
              forceClaimedFrom: claimedFrom,
            },
          } as Event)
        : event;
      const hook: Hook = {
        runId,
        hookId,
        token: hookData.token,
        metadata: hookData.metadata,
        ownerId: "local-owner",
        projectId: "local-project",
        environment: "local",
        createdAt: now,
        specVersion,
        isWebhook: hookData.isWebhook ?? false,
        isSystem: hookData.isSystem ?? false,
        tokenRetentionUntil: hookData.tokenRetentionUntil,
        ...(claimedFrom && { claimedFrom }),
      };
      store.setTokenOwner(hookData.token, hookId, runId, hookData.tokenRetentionUntil);
      store.upsertHook(hook);
      return { kind: "created", event: stored, hook };
    }
    async function withSkippedReport(
      result: EventResult,
      params: CreateEventParams | undefined,
    ): Promise<EventResult> {
      if (
        params?.eventCount === undefined ||
        typeof params.sinceCursor === "string" ||
        !result.event
      ) {
        return result;
      }
      const committedSlot = Number(result.event.eventId.slice("evnt_".length));
      const askedFor = params.eventCount;
      if (!Number.isFinite(committedSlot) || askedFor < 1 || committedSlot <= askedFor + 1) {
        return result;
      }
      const resolveData = resolveOf(params);
      const events = (await store.eventsBetween(result.event.runId, askedFor, committedSlot)).map(
        (event) => stripEventDataRefs(event, resolveData),
      );
      return {
        ...result,
        events,
        cursor: null,
        hasMore: events.length < committedSlot - askedFor - 1,
      } as EventResult;
    }
    return { createInTransaction, withSkippedReport };
  }
  function validateRequest(runId: string | null, data: AnyEventRequest): void {
    if (
      data.eventType === "hook_created" &&
      data.eventData.tokenRetentionUntil !== undefined &&
      new Date(data.eventData.tokenRetentionUntil).getTime() > Date.now() + hookRetentionLimitMs
    ) {
      throw new WorkflowWorldError(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Local World.`,
        { status: 400 },
      );
    }
    if (data.eventType === "hook_created" && runId && isStartHookId(runId, data.correlationId)) {
      throw new WorkflowWorldError(
        `Hook id "${data.correlationId}" is the start Hook of workflow run "${runId}" and is created by its admission`,
        { status: 400 },
      );
    }
    const startHookRetention =
      data.eventType === "run_created" || data.eventType === "run_started"
        ? (
            data.eventData as
              | {
                  startHook?: StartHook;
                }
              | undefined
          )?.startHook?.tokenRetentionUntil
        : undefined;
    if (
      startHookRetention !== undefined &&
      new Date(startHookRetention).getTime() > Date.now() + hookRetentionLimitMs
    ) {
      throw startHookRejected(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Local World.`,
        "invalid",
      );
    }
    if (runId != null && runId !== "") assertSafeEntityId("runId", runId);
    if ("correlationId" in data && typeof data.correlationId === "string") {
      assertSafeEntityId("correlationId", data.correlationId);
    }
  }
  async function create(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> {
    validateRequest(runId, data);
    const fenced = params?.inBand === true && !!runId && data.eventType !== "run_created";
    if (fenced) {
      const expected = params.expectedSeqInBand;
      if (expected === undefined || !Number.isSafeInteger(expected) || expected < 0) {
        throw new WorkflowWorldError(
          `An in-band write to run ${runId} must carry a nonnegative integer expectedSeqInBand`,
          { status: 400 },
        );
      }
    }
    const effects: Array<() => void> = [];
    const result = await database.transact(async (unit) => {
      const store = reader.in(unit);
      const { createInTransaction, withSkippedReport } = inTransaction(store);
      try {
        if (fenced) {
          const current = await store.getRun(runId!);
          const seqInBand = current?.seqInBand ?? IN_BAND_SEQ_AT_RUN_CREATION;
          if (seqInBand !== params!.expectedSeqInBand) {
            throw new InBandSupersededError(
              `In-band write on run ${runId} expected seqInBand ${params!.expectedSeqInBand}, but the run is at ${seqInBand}. Another orchestrator wrote in-band events this one has not seen; stop writing and redeliver.`,
              { seqInBand, seq: await store.topSeq(runId!) },
            );
          }
        }
        const seqBefore = fenced ? await store.topSeq(runId!) : 0;
        const created = await createInTransaction(runId, data, params, effects);
        let result = created;
        if (fenced) {
          const allocated = (await store.topSeq(runId!)) > seqBefore ? 1 : 0;
          if (allocated > 0) await store.advanceInBand(runId!);
          result = { ...created, allocated } as EventResult;
        }
        return await withSkippedReport(result, params);
      } catch (error) {
        if (error instanceof RecordedRefusal) {
          return new CommitThenThrow(error.refusal) as never;
        }
        throw error;
      }
    });
    for (const effect of effects) effect();
    return result;
  }

  return {
    async create(runId: string | null, data: AnyEventRequest, params?: CreateEventParams) {
      return create(runId, data, params);
    },
    async get(runId, eventId, params) {
      assertSafeEntityId("runId", runId);
      assertSafeEntityId("eventId", eventId);
      const event = await reader.getEvent(runId, eventId);
      if (!event) {
        throw new Error(`Event ${eventId} in run ${runId} not found`);
      }
      return stripEventDataRefs(event, params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION);
    },
    async list(params) {
      assertSafeEntityId("runId", params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const runRow = await reader.getRunAnyTag(params.runId);
      const snapshot = {
        seq: runRow?.seq ?? 0,
        seqInBand: runRow?.seqInBand ?? IN_BAND_SEQ_AT_RUN_CREATION,
      };
      const result = await reader.listEvents(params.runId, {
        cursor: params.pagination?.cursor,
        limit: params.pagination?.limit ?? getMaxEventsPerRun(),
        sortOrder: params.pagination?.sortOrder ?? "asc",
        maxBytes: MAX_EVENT_PAGE_BYTES,
      });
      return {
        ...result,
        data:
          resolveData === "all"
            ? result.data
            : result.data.map((event) => stripEventDataRefs(event, resolveData)),
        snapshot,
        ...(runRow ? { maxEvents: getMaxEventsForRun(runRow.run) } : {}),
      };
    },
    async listByCorrelationId(params) {
      assertSafeEntityId("runId", params.runId);
      assertSafeEntityId("correlationId", params.correlationId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await reader.listEvents(params.runId, {
        correlationId: params.correlationId,
        cursor: params.pagination?.cursor,
        limit: params.pagination?.limit,
        sortOrder: params.pagination?.sortOrder ?? "asc",
        maxBytes: MAX_EVENT_PAGE_BYTES,
      });
      return {
        ...result,
        data:
          resolveData === "all"
            ? result.data
            : result.data.map((event) => stripEventDataRefs(event, resolveData)),
      } as PaginatedResponse<Event>;
    },
    clearCache() {},
  } as LocalEventsStorage;
}
function buildRun(
  runId: string,
  data: RunCreationData,
  specVersion: number,
  now: Date,
): WorkflowRun {
  return {
    runId,
    deploymentId: data.deploymentId,
    status: "pending",
    workflowName: data.workflowName,
    specVersion,
    executionContext: data.executionContext,
    input: data.input,
    output: undefined,
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
    attributes: data.attributes ?? {},
    encryptionPublicKey: data.encryptionPublicKey,
    dynamicWorkflowCode: data.dynamicWorkflowCode,
    ...(data.startHook ? { startHook: withStartHookId(data.startHook, runId) } : {}),
    createdAt: now,
    updatedAt: now,
  } as WorkflowRun;
}
function runCreatedEvent(run: WorkflowRun, data: RunCreationData, now: Date): Event {
  const eventData: Record<string, unknown> = {
    deploymentId: data.deploymentId,
    workflowName: data.workflowName,
    input: data.input,
    executionContext: data.executionContext,
    attributes: data.attributes,
    allowReservedAttributes: data.allowReservedAttributes,
    encryptionPublicKey: data.encryptionPublicKey,
  };
  if (run.startHook) eventData.startHook = run.startHook;
  return {
    eventType: "run_created",
    runId: run.runId,
    createdAt: now,
    specVersion: run.specVersion,
    eventData,
  } as Event;
}
export function withRunPayloadsPurged<T extends WorkflowRun>(run: T, purgedAt: Date): T {
  return {
    ...run,
    input: undefined,
    output: undefined,
    error: undefined,
    dynamicWorkflowCode: undefined,
    ...(run.startHook?.metadata !== undefined && {
      startHook: { ...run.startHook, metadata: undefined },
    }),
    expiredAt: purgedAt,
  };
}
export function payloadDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export { getEventDataRefFields, eventCursor, slotToEventId };

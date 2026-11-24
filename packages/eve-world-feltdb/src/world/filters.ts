/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/filters.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import type {
  Hook,
  Step,
  StepWithoutData,
  WorkflowRun,
  WorkflowRunWithoutData,
} from "@workflow/world";
export { stripEventDataRefs } from "@workflow/world";
export function filterRunData(run: WorkflowRun, resolveData: "none"): WorkflowRunWithoutData;
export function filterRunData(run: WorkflowRun, resolveData: "all"): WorkflowRun;
export function filterRunData(
  run: WorkflowRun,
  resolveData: "none" | "all",
): WorkflowRun | WorkflowRunWithoutData;
export function filterRunData(
  run: WorkflowRun,
  resolveData: "none" | "all",
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === "none") {
    const { dynamicWorkflowCode: _dynamicWorkflowCode, ...rest } = run;
    return {
      ...rest,
      input: undefined,
      output: undefined,
    } as WorkflowRunWithoutData;
  }
  return run;
}
export function filterStepData(step: Step, resolveData: "none"): StepWithoutData;
export function filterStepData(step: Step, resolveData: "all"): Step;
export function filterStepData(step: Step, resolveData: "none" | "all"): Step | StepWithoutData;
export function filterStepData(step: Step, resolveData: "none" | "all"): Step | StepWithoutData {
  if (resolveData === "none") {
    return {
      ...step,
      input: undefined,
      output: undefined,
    } as StepWithoutData;
  }
  return step;
}
export function filterHookData(hook: Hook, resolveData: "none" | "all"): Hook {
  if (resolveData === "none") {
    const { metadata: _metadata, ...rest } = hook as any;
    return rest;
  }
  return hook;
}

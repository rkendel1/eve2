/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/config.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { createWorkflowBaseUrl, createWorkflowHealthEndpoint } from "@workflow/utils";
import { getWorkflowPort } from "@workflow/utils/get-port";
import { once } from "./util.js";
const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data";
};
export const DEFAULT_RESOLVE_DATA_OPTION = "all";
const getBaseUrlFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_BASE_URL;
};
export type Config = {
  dataDir: string;
  port?: number;
  baseUrl?: string;
  recoverActiveRuns?: boolean;
  tag?: string;
  streamFlushIntervalMs?: number;
  queueAuthKey?: "regenerate" | "read";
  readUnstampedRunSpec?: boolean;
};
export const config = once<Config>(() => {
  const dataDir = getDataDirFromEnv();
  const baseUrl = getBaseUrlFromEnv();
  return { dataDir, baseUrl };
});
export function resolveRecoverActiveRuns(config: Partial<Config>): boolean {
  if (config.recoverActiveRuns !== undefined) {
    return config.recoverActiveRuns;
  }
  const raw = process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS?.toLowerCase();
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return true;
}
export function resolveDirectBaseUrl(config: Partial<Config>): string {
  return (
    config.baseUrl ||
    process.env.WORKFLOW_LOCAL_BASE_URL ||
    createWorkflowBaseUrl("http://localhost")
  );
}
export async function resolveBaseUrl(config: Partial<Config>): Promise<string> {
  if (config.baseUrl) {
    return config.baseUrl;
  }
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    return process.env.WORKFLOW_LOCAL_BASE_URL;
  }
  if (typeof config.port === "number") {
    return createWorkflowBaseUrl(`http://localhost:${config.port}`);
  }
  if (process.env.PORT) {
    return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
  }
  const detectedPort = await getWorkflowPort({
    endpoint: createWorkflowHealthEndpoint(),
  });
  if (detectedPort) {
    return createWorkflowBaseUrl(`http://localhost:${detectedPort}`);
  }
  throw new Error("Unable to resolve base URL for workflow queue.");
}

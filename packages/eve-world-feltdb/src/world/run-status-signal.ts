/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/storage/run-status-signal.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { EventEmitter } from "node:events";
const emitter = new EventEmitter<{
  [key: `run:${string}`]: [];
}>();
emitter.setMaxListeners(0);
export const RUN_STATUS_POLL_INTERVAL_MS = 100;
export function signalRunTerminal(runId: string): void {
  emitter.emit(`run:${runId}`);
}
export function waitForRunTerminalSignal(
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const key = `run:${runId}` as const;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.off(key, settle);
      signal?.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    emitter.once(key, settle);
    signal?.addEventListener("abort", settle, { once: true });
  });
}

/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/ids.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { WorkflowWorldError } from "@workflow/errors";
function truncateForError(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  const MAX = 48;
  return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
}
export class UnsafeEntityIdError extends WorkflowWorldError {
  constructor(kind: string, value: string) {
    super(
      `Unsafe ${kind} "${truncateForError(value)}": must not be empty, contain ".", "/", "\\", or null bytes`,
    );
    this.name = "UnsafeEntityIdError";
  }
  static override is(value: unknown): value is UnsafeEntityIdError {
    return value instanceof Error && value.name === "UnsafeEntityIdError";
  }
}
export function assertSafeEntityId(kind: string, value: string): void {
  if (
    value.length === 0 ||
    value.includes(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new UnsafeEntityIdError(kind, value);
  }
}

/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/util.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
export function once<T>(fn: () => T) {
  const result = {
    get value() {
      const value = fn();
      Object.defineProperty(result, "value", { value });
      return value;
    },
  };
  return result;
}

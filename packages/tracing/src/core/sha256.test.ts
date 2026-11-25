import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { randomHex, sha256Hex } from "./sha256.js";

describe("sha256Hex", () => {
  it.each([
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1000),
    "turn:run-1:turn-2",
    "héllo · 日本 · 😀",
  ])("matches node:crypto for %j, so derived trace and span ids do not change", (text) => {
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
  });
});

describe("randomHex", () => {
  it("returns lowercase hex of the requested byte length", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(8)).not.toBe(randomHex(8));
  });
});

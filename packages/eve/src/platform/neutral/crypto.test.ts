import { createHash as nodeCreateHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createHash, randomUUID } from "./crypto.ts";

const inputs = [
  "",
  "abc",
  "a".repeat(55),
  "a".repeat(56),
  "a".repeat(64),
  "a".repeat(1000),
  "héllo · 日本 · 😀",
  JSON.stringify({ sessionId: "s-1", history: [{ role: "user", content: "x".repeat(300) }] }),
];

describe("neutral sha256", () => {
  it.each(inputs)("matches node:crypto for %j in every encoding", (input) => {
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(createHash("sha256").update(input).digest(encoding)).toBe(
        nodeCreateHash("sha256").update(input).digest(encoding),
      );
    }
    expect(Array.from(createHash("sha256").update(input).digest())).toEqual(
      Array.from(nodeCreateHash("sha256").update(input).digest()),
    );
  });

  it("hashes several updates as their concatenation, bytes and text alike", () => {
    const bytes = new TextEncoder().encode("tail");
    expect(createHash("sha256").update("head-").update(bytes).digest("hex")).toBe(
      nodeCreateHash("sha256").update("head-tail").digest("hex"),
    );
  });

  it("refuses algorithms it does not implement, naming them", () => {
    expect(() => createHash("sha1")).toThrow(/"sha1" needs node:crypto/);
  });
});

describe("neutral randomUUID", () => {
  it("uses the host's Web Crypto", () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

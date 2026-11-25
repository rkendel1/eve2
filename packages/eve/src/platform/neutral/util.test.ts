import { isDeepStrictEqual as nodeIsDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import { isDeepStrictEqual } from "./util.ts";

const message = {
  role: "assistant",
  content: [
    { type: "text", text: "hi" },
    { type: "tool-call", toolCallId: "1", input: { a: 1 } },
  ],
};
const pairs: [string, unknown, unknown][] = [
  ["equal messages", [message], [structuredClone(message)]],
  [
    "changed nested value",
    [message],
    [
      {
        ...message,
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", toolCallId: "1", input: { a: 2 } },
        ],
      },
    ],
  ],
  ["extra key", { a: 1 }, { a: 1, b: undefined }],
  ["array vs object", [1, 2], { 0: 1, 1: 2 }],
  ["different lengths", [1, 2], [1, 2, 3]],
  ["NaN", Number.NaN, Number.NaN],
  ["+0 and -0", 0, -0],
  ["number and string", 1, "1"],
  ["null and undefined", null, undefined],
  ["dates", new Date(5), new Date(5)],
  ["different dates", new Date(5), new Date(6)],
  ["bytes", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ["different bytes", new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  ["prototype differs", Object.create(null), {}],
  ["empty arrays", [], []],
];

describe("neutral isDeepStrictEqual", () => {
  it.each(pairs)("agrees with node:util for %s", (_name, a, b) => {
    expect(isDeepStrictEqual(a, b)).toBe(nodeIsDeepStrictEqual(a, b));
  });
});

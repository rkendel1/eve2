import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import { basename, dirname, extname, isAbsolute, join, normalize } from "./path.ts";

const paths = [
  "",
  "/",
  "//",
  "a",
  "a/",
  "/a",
  "/a/b",
  "/a/b/",
  "a/b/c.txt",
  "/tmp/x/.eve/abc123/file.png",
  "file.tar.gz",
  ".hidden",
  "..",
  ".",
  "a/..",
  "dir.d/",
  "name.",
  "a//b//",
  "/abc/def/ghi.json",
];

describe("neutral path (POSIX)", () => {
  it.each(paths)("agrees with node:path/posix for %j", (path) => {
    expect(basename(path)).toBe(posix.basename(path));
    expect(dirname(path)).toBe(posix.dirname(path));
    expect(extname(path)).toBe(posix.extname(path));
    expect(isAbsolute(path)).toBe(posix.isAbsolute(path));
    expect(normalize(path)).toBe(posix.normalize(path));
  });

  it.each([
    "a/./b",
    "a/../../b",
    "/../a",
    "./",
    "../",
    "a/b/../../..",
    "tools/../tools/x.ts",
    "..a/b",
    "a/..b/../c",
    "a/.../b",
  ])("normalizes %j as node does", (path) => {
    expect(normalize(path)).toBe(posix.normalize(path));
  });

  it("joins as node does", () => {
    for (const parts of [
      ["a", "b"],
      ["/a", "../b"],
      ["", ""],
      ["a", "", "b/"],
      ["subagents/x", "extensions", "ns"],
    ]) {
      expect(join(...parts)).toBe(posix.join(...parts));
    }
  });

  it("strips a suffix as node does", () => {
    expect(basename("/a/b/report.pdf", ".pdf")).toBe(posix.basename("/a/b/report.pdf", ".pdf"));
    expect(basename("/a/b/.pdf", ".pdf")).toBe(posix.basename("/a/b/.pdf", ".pdf"));
  });
});

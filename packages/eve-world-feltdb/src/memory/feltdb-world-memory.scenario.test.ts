import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function runChild(dir: string, body: string): Promise<string> {
  const file = join(
    packageRoot,
    `.memory-child-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(
    file,
    `import { feltdbWorldMemory } from ${JSON.stringify(join(packageRoot, "dist/index.js"))};
process.env.EVE_FELTDB_PATH = ${JSON.stringify(dir)};
${body}`,
  );
  cleanups.push(() => rmSync(file, { force: true }));
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.once("close", (code) =>
      code === 0 ? resolveRun(out.trim()) : reject(new Error(`exit ${code}`)),
    );
  });
}

describe("feltdbWorldMemory", () => {
  it("keeps memory in FeltDB beside the World across processes, sharing one handle per process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-world-memory-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const written = await runChild(
      dir,
      `const a = feltdbWorldMemory(); const b = feltdbWorldMemory();
const first = await a.write({ key: "agent/alice", content: "prefers tea", expectedVersion: null });
const seenByB = await b.read({ key: "agent/alice" });
console.log(JSON.stringify({ first, seenByB }));`,
    );
    const { first, seenByB } = JSON.parse(written) as {
      first: { version: string };
      seenByB: unknown;
    };
    expect(seenByB).toEqual({ content: "prefers tea", version: first.version });
    const reread = await runChild(
      dir,
      `const memory = feltdbWorldMemory();
const doc = await memory.read({ key: "agent/alice" });
const next = await memory.write({ key: "agent/alice", content: "prefers coffee", expectedVersion: doc.version });
console.log(JSON.stringify({ doc, next }));`,
    );
    const { doc, next } = JSON.parse(reread) as {
      doc: { content: string };
      next: { content: string };
    };
    expect(doc.content).toBe("prefers tea");
    expect(next.content).toBe("prefers coffee");
  });

  it("explains what it needs when it has no directory", async () => {
    const { feltdbWorldMemory } = await import("../index.js");
    const saved = process.env.EVE_FELTDB_PATH;
    delete process.env.EVE_FELTDB_PATH;
    try {
      expect(() => feltdbWorldMemory()).toThrow(/EVE_FELTDB_PATH/);
    } finally {
      if (saved !== undefined) process.env.EVE_FELTDB_PATH = saved;
    }
  });
});

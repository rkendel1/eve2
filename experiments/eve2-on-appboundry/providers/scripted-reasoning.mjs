// A SCRIPTED STAND-IN FOR THE MODEL, for the fault-injection suite only. It serves reasoning.decide@1 like the Claude
// provider, but its decisions are a fixed script for the fixture repository, chosen from what Eve has already observed
// (not from a call count), so a decision lost in a crash is simply taken again. It tests Eve's recovery, not judgment.
import { defineCapability } from "@appport/core";
import { s } from "@appport/schema";
import { log, serve } from "./serve.mjs";

const TEST = "test/chunk-tail.test.js";
const SOURCE = "src/chunk.js";
const FIXED = `export function chunk(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n`;
const REPRO = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { chunk } from "../src/chunk.js";\n\ntest("chunk keeps the final partial chunk", () => {\n  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n});\n`;
let calls = 0;

const act = (action, input, rationale) => ({ kind: "act", action, inputJson: JSON.stringify(input), resultJson: null, rationale });
const finish = (result, rationale) => ({ kind: "finish", action: null, inputJson: null, resultJson: JSON.stringify(result), rationale });

function assess(obs) {
  if (!obs.includes(`read {"path":"${SOURCE}"`)) return act("read", { path: SOURCE }, "Read the chunking code.");
  if (!new RegExp(`wrote ${TEST.replace(/[./]/g, "\\$&")}`).test(obs)) return act("write", { path: TEST, content: REPRO }, "Write a test for the final partial chunk.");
  if (!/run \{"check":"test","target":"test\/chunk-tail\.test\.js"[^\n]*\n[^\n]*exit [1-9]/.test(obs)) return act("run", { check: "test", target: TEST, against: "change" }, "Run the reproduction.");
  return finish({ findings: [{
    title: "chunk drops the final partial chunk", severity: "medium",
    summary: "chunk(items, size) stops one chunk early: for 5 items in chunks of 2 it returns [[1,2],[3,4]] and loses [5].",
    evidence: [{ kind: "code", path: SOURCE, startLine: 3, endLine: 3, quote: "for (let i = 0; i < items.length - size; i += size)" }, { kind: "check", check: "test", target: TEST, expect: "fails" }],
    fix: "Loop while i < items.length.",
  }] }, "The reproduction fails on its assertion.");
}

function resolve(obs) {
  if (!obs.includes(`read {"path":"${SOURCE}"`)) return act("read", { path: SOURCE }, "Read the code at fault.");
  if (!new RegExp(`wrote ${SOURCE.replace(/[./]/g, "\\$&")}`).test(obs)) return act("write", { path: SOURCE, content: FIXED }, "Fix the loop bound.");
  const afterWrite = obs.slice(obs.lastIndexOf(`wrote ${SOURCE}`));
  if (!/against change: exit 0/.test(afterWrite)) return act("run", { check: "test", target: TEST, against: "change" }, "Run the reproduction on the change.");
  return finish({ summary: "chunk's loop stopped at items.length - size, dropping the final partial chunk; it now runs to items.length.", tests: [TEST] }, "The reproduction passes.");
}

const decide = defineCapability({
  name: "reasoning.decide", version: 1, description: "Scripted decisions for the fault-injection fixture.",
  input: s.object({ objective: s.string(), guidance: s.string(), actions: s.unknown(), observations: s.string(), resultShape: s.string() }),
  output: s.object({ decision: s.unknown(), usage: s.unknown() }), authorization: [],
  handler: async ({ objective, observations }) => {
    calls += 1;
    const decision = objective.startsWith("Resolve") ? resolve(observations) : assess(observations);
    log("decide", { calls, kind: decision.kind, action: decision.action });
    return { decision, usage: { provider: "scripted", calls } };
  },
});
const interpret = defineCapability({
  name: "reasoning.interpret", version: 1, description: "Not used by the fixture.", input: s.unknown(), output: s.unknown(), authorization: [],
  handler: async () => ({ result: null, usage: { provider: "scripted" } }),
});

serve({ id: "reasoning-scripted", name: "Scripted reasoning", capabilities: [decide, interpret], port: Number(process.env.PORT), consumerToken: process.env.CONSUMER_TOKEN });
export { FIXED, REPRO, TEST, SOURCE };

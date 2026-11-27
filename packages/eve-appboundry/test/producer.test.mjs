import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveKeep, HOST_BASE } from "../src/keep.mjs";
import { produce, ProduceError, readDeclaration } from "../src/produce.mjs";
import { findSecrets } from "../src/secrets.mjs";
import { appendCustomSection, customSections, PROGRAM_SECTION } from "../src/wasm.mjs";
import { artifactOf, cleanup, ENGINE, fixture, needsEngine, PACKAGE, scratch } from "./support.mjs";

after(cleanup);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refusal = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProduceError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
};
const eveDist = join(PACKAGE, "node_modules/eve/dist/src/");

describe("the program section", () => {
  it("appends the program as the appboundry.program custom section and reads it back", () => {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const program = new TextEncoder().encode("globalThis.__abg = {};".repeat(20));
    const module = appendCustomSection(empty, PROGRAM_SECTION, program);
    assert.deepEqual(
      customSections(module).map((s) => [s.name, new TextDecoder().decode(s.payload)]),
      [[PROGRAM_SECTION, new TextDecoder().decode(program)]],
    );
    assert.throws(() => appendCustomSection(module, PROGRAM_SECTION, program), /already has/);
    assert.throws(() => customSections(new Uint8Array([1, 2, 3])), /not a WebAssembly/);
  });
});

describe("credentials", () => {
  it("finds credential formats and credential-named variables' values, naming neither value", () => {
    const env = { MODEL_API_KEY: "a-model-key-of-some-length", PATH: "/usr/bin" };
    const found = findSecrets(
      `const k = "sk-ant-${"x".repeat(30)}"; const v = "a-model-key-of-some-length";`,
      "the program",
      env,
    );
    assert.deepEqual(found, [
      "the program contains an Anthropic API key",
      "the program contains the value of $MODEL_API_KEY",
    ]);
    assert.ok(!found.join(" ").includes("a-model-key-of-some-length"));
    assert.deepEqual(findSecrets("const path = '/usr/bin';", "the program", env), []);
  });
});

describe("the declaration", () => {
  it("requires appboundry.json with the application's id, name and version", async () => {
    const app = join(scratch(), "agent");
    cpSync(fixture("minimal-agent"), app, { recursive: true, filter: (p) => !p.includes(".eve") });
    writeFileSync(
      join(app, "appboundry.json"),
      JSON.stringify({ application: { id: "org-eve", name: "x" } }),
    );
    assert.throws(() => readDeclaration(app), /application.version is required/);
    writeFileSync(
      join(app, "appboundry.json"),
      JSON.stringify({ application: { id: "org-eve", name: "x", version: "1" }, model: "x" }),
    );
    assert.throws(() => readDeclaration(app), /unknown field model/);
  });
});

describe("the keep list", () => {
  it("fails, naming the module, when the compiled agent loads an eve source the registry does not name", () => {
    const dir = scratch();
    const moduleMapPath = join(dir, "module-map.mjs");
    writeFileSync(
      moduleMapPath,
      [
        `import { loadFrameworkProgrammaticModule as loadProgrammaticModule } from "eve/internal/programmatic-source-loader";`,
        `const module_0 = await loadProgrammaticModule({"kind":"programmatic","moduleId":"tools/teleport.ts","registryId":"eve:defaults","revision":"r"});`,
        `export const moduleMap = Object.freeze({ "nodes": Object.freeze({ "__root__": Object.freeze({ "modules": Object.freeze({ "eve:defaults:tools/teleport.ts": module_0 }) }) }) });`,
        `export default moduleMap;`,
      ].join("\n"),
    );
    assert.throws(
      () => deriveKeep({ moduleMapPath, eveDist }),
      /eve:defaults:tools\/teleport\.ts \(agent node __root__\), which eve's framework registry/,
    );
  });
});

describe("producing the organization's agent", { skip: needsEngine, timeout: 600_000 }, () => {
  it("writes manifest.json and module.wasm: FeltKit's engine with the program in its section", async () => {
    const { path, manifest } = await artifactOf("minimal-agent");
    const module = readFileSync(join(path, "module.wasm"));
    const written = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    assert.deepEqual(written, manifest);
    assert.equal(manifest.module.sha256, sha256(module));
    const [program] = customSections(new Uint8Array(module)).filter(
      (s) => s.name === PROGRAM_SECTION,
    );
    assert.ok(program, "the program section is present");
    assert.equal(manifest.module.program.sha256, sha256(program.payload));
    assert.ok(new TextDecoder().decode(program.payload).includes("appboundry-guest/1"));
    const engine = new Uint8Array(readFileSync(ENGINE));
    assert.deepEqual(
      new Uint8Array(module.subarray(0, engine.length)),
      engine,
      "the module is the engine plus the section",
    );
  });

  it("derives the manifest from the compiled agent and its declaration", async () => {
    const { manifest, report } = await artifactOf("minimal-agent");
    assert.deepEqual(manifest.application, readDeclaration(fixture("minimal-agent")).application);
    assert.deepEqual(manifest.runtime, {
      abi: "appboundry-guest/1",
      interfaces: { actions: 1, agents: 1, identity: 1, model: 1, sessions: 1, capabilities: 1 },
    });
    assert.deepEqual(
      manifest.requires.map((r) => r.name),
      ["repo.changes.get", "repo.changes.publish"],
    );
    assert.deepEqual(
      manifest.functions.map((f) => [f.name, f.kind, f.agent?.session]),
      [
        ["eve:deliver", "action", "session"],
        ["eve:answer", "action", "session"],
      ],
    );
    assert.ok(
      manifest.omitted.some((line) =>
        line.startsWith("model: anthropic/claude-sonnet-5 is a reference"),
      ),
    );
    assert.deepEqual(
      report.agent.tools.map((t) => [t.tool, t.decision]),
      [
        ["repo_changes_get", "bundled: the module map imports it"],
        ["repo_changes_publish", "bundled: the module map imports it"],
      ],
    );
    const framework = await artifactOf("framework-tools-agent");
    assert.deepEqual(
      framework.manifest.requires.map((r) => r.name),
      ["repo.changes.get"],
    );
  });

  it("imports no Node built-in on eve's turn path, and carries no credential or build-machine path", async () => {
    const { path, report } = await artifactOf("minimal-agent");
    assert.deepEqual(report.staticGraph.nodeBuiltins, []);
    const program = readFileSync(join(path, "module.wasm"), "latin1");
    assert.ok(!program.includes(PACKAGE), "the program names the build machine's paths");
    assert.ok(program.includes("/appboundry/agent/"));
    assert.deepEqual(
      findSecrets(readFileSync(join(path, "module.wasm"), "utf8"), "module.wasm"),
      [],
    );
  });

  it("keeps what the agent declares and stubs the rest: the same eve, different tools, a different bundle", async () => {
    const minimal = (await artifactOf("minimal-agent")).report;
    const framework = (await artifactOf("framework-tools-agent")).report;
    for (const { module } of HOST_BASE)
      assert.ok(minimal.keep.some((k) => k.module === `eve/dist/src/${module}`));
    assert.deepEqual(
      minimal.keep.map((k) => k.module).sort(),
      framework.keep.map((k) => k.module).sort(),
    );
    for (const provided of ["bash.js", "read-file.js", "web-fetch.js"])
      assert.ok(
        `eve/dist/src/tools/provided/${provided}` in minimal.stubbed,
        `${provided} is stubbed`,
      );
    assert.deepEqual(
      framework.agent.tools.map((t) => [t.tool, t.nodeBuiltins.length]),
      [
        ["ask_question", 0],
        ["no_reply", 0],
        ["repo_changes_get", 0],
      ],
    );
    for (const report of [minimal, framework])
      for (const kept of report.keep)
        assert.ok(!(kept.module in report.stubbed), `${kept.module} is kept and stubbed`);
  });

  it("keeps eve's default tools for an agent that has them, and refuses the agent because they could not run", async () => {
    const out = join(scratch(), "default.app");
    await assert.rejects(
      produce({ appRoot: fixture("default-tools-agent"), engine: ENGINE, out }),
      (error) => {
        assert.equal(error.code, "TOOL_UNAVAILABLE");
        assert.match(error.message, /bash \(eve:defaults:tools\/bash\.ts\): node:crypto/);
        assert.match(error.message, /web_fetch \(eve:defaults:tools\/web_fetch\.ts\): node:dns/);
        assert.match(error.message, /defaultTools: false/);
        const kept = error.report.keep.map((k) => k.module);
        for (const provided of [
          "bash.js",
          "read-file.js",
          "write-file.js",
          "edit-file.js",
          "web-fetch.js",
        ])
          assert.ok(
            kept.includes(`eve/dist/src/tools/provided/${provided}`),
            `${provided} is kept`,
          );
        assert.ok(!("eve/dist/src/tools/provided/bash.js" in error.report.stubbed));
        return true;
      },
    );
  });

  it("refuses an agent that declares bash, read_file and web_fetch, naming each tool and what it needs", async () => {
    await assert.rejects(
      produce({
        appRoot: fixture("declared-tools-agent"),
        engine: ENGINE,
        out: join(scratch(), "declared.app"),
      }),
      (error) => {
        assert.equal(error.code, "TOOL_UNAVAILABLE");
        assert.match(
          error.message,
          /bash \(tools\/bash\.ts\): node:crypto, from eve\/dist\/src\/execution\/sandbox\/bash\.js/,
        );
        assert.match(error.message, /read_file \(tools\/read_file\.ts\): node:crypto, node:path/);
        assert.match(error.message, /web_fetch \(tools\/web_fetch\.ts\): node:dns/);
        assert.deepEqual(
          error.report.agent.tools.find((t) => t.tool === "repo_changes_get").nodeBuiltins,
          [],
        );
        return true;
      },
    );
  });

  it("rebuilds the same bytes from the same inputs", async () => {
    const first = await artifactOf("minimal-agent");
    const again = await produce({
      appRoot: fixture("minimal-agent"),
      engine: ENGINE,
      out: join(scratch(), "again.app"),
    });
    assert.equal(again.manifest.module.sha256, first.manifest.module.sha256);
    assert.equal(
      readFileSync(join(again.path, "manifest.json"), "utf8"),
      readFileSync(join(first.path, "manifest.json"), "utf8"),
    );
  });

  it("refuses an engine that already carries a program, and an output that is not an artifact", async () => {
    const dir = scratch();
    const carrying = join(dir, "engine.wasm");
    writeFileSync(
      carrying,
      appendCustomSection(
        new Uint8Array(readFileSync(ENGINE)),
        PROGRAM_SECTION,
        new TextEncoder().encode("x"),
      ),
    );
    await refusal(
      produce({ appRoot: fixture("minimal-agent"), engine: carrying, out: join(dir, "a.app") }),
      "ENGINE_INVALID",
    );
    const occupied = join(dir, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "notes.txt"), "Alice's notes");
    await refusal(
      produce({ appRoot: fixture("minimal-agent"), engine: ENGINE, out: occupied }),
      "OUT_CONFLICT",
    );
    assert.equal(readFileSync(join(occupied, "notes.txt"), "utf8"), "Alice's notes");
  });
});

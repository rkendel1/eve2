import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleGuest } from "./bundle.mjs";
import { deriveKeep } from "./keep.mjs";
import { artifactManifest } from "./manifest.mjs";
import { moduleMapEntries } from "./module-map.mjs";
import { findSecrets } from "./secrets.mjs";
import { appendCustomSection, customSections, PROGRAM_SECTION } from "./wasm.mjs";

export class ProduceError extends Error {
  constructor(code, message, report) {
    super(message);
    this.code = code;
    if (report) this.report = report;
  }
}
const fail = (code, message, report) => {
  throw new ProduceError(code, message, report);
};

export function readDeclaration(appRoot) {
  const path = join(appRoot, "appboundry.json");
  if (!existsSync(path)) {
    fail(
      "DECLARATION_MISSING",
      `${path} is missing. It names the application: { "application": { "id": "org-eve", "name": "...", "version": "1.0.0" }, "requires": [{ "name": "<capability>", "versions": "1" }] }.`,
    );
  }
  const declaration = JSON.parse(readFileSync(path, "utf8"));
  const application = declaration.application ?? {};
  for (const field of ["id", "name", "version"])
    if (typeof application[field] !== "string" || !application[field])
      fail("DECLARATION_INVALID", `${path}: application.${field} is required`);
  const unknown = Object.keys(declaration).filter(
    (key) => !["application", "requires"].includes(key),
  );
  if (unknown.length)
    fail(
      "DECLARATION_INVALID",
      `${path}: unknown field ${unknown.join(", ")} (allowed: application, requires)`,
    );
  return {
    application: {
      id: application.id,
      name: application.name,
      version: application.version,
      ...(application.description ? { description: application.description } : {}),
    },
    requires: declaration.requires ?? [],
  };
}

async function eveOf(appRoot) {
  let manifestPath;
  try {
    manifestPath = createRequire(join(appRoot, "package.json")).resolve("eve/package.json");
  } catch {
    fail(
      "EVE_NOT_FOUND",
      `eve is not installed for ${appRoot}; install the agent's dependencies first`,
    );
  }
  const root = dirname(manifestPath);
  const dist = join(root, "dist/src/");
  if (!existsSync(join(dist, "compiler/compile-agent.js")))
    fail(
      "EVE_NOT_BUILT",
      `${root} has no built dist (dist/src/compiler/compile-agent.js); build eve first (pnpm --filter eve build)`,
    );
  const { compileAgent } = await import(
    pathToFileURL(join(dist, "compiler/compile-agent.js")).href
  );
  return { version: JSON.parse(readFileSync(manifestPath, "utf8")).version, dist, compileAgent };
}

function agentTools(compiled, keep) {
  const entries = moduleMapEntries(compiled.paths.moduleMapPath).filter(
    (entry) => entry.node === "__root__",
  );
  return (compiled.manifest.tools ?? []).map((tool) => {
    const entry = entries.find((e) => e.key === tool.sourceId);
    if (!entry)
      return {
        tool: tool.name,
        source: tool.sourceId,
        path: null,
        decision: "built in: no module of its own",
      };
    if (entry.kind === "authored")
      return {
        tool: tool.name,
        source: tool.sourceId,
        path: entry.path,
        decision: "bundled: the module map imports it",
      };
    const kept = keep.find((k) => k.from.includes(entry.key));
    return {
      tool: tool.name,
      source: tool.sourceId,
      path: kept?.module ?? null,
      decision: kept ? "kept: the module map loads it on demand" : "missing",
    };
  });
}

export async function produce({ appRoot: appRootInput, engine: enginePath, out: outInput }) {
  const appRoot = resolve(appRootInput);
  const out = resolve(outInput);
  const declaration = readDeclaration(appRoot);
  if (!enginePath || !existsSync(enginePath))
    fail(
      "ENGINE_MISSING",
      `the guest engine ${String(enginePath)} does not exist; pass --engine <@feltdb/feltkit>/appboundry/engine.wasm`,
    );
  const engine = new Uint8Array(readFileSync(enginePath));
  let sections;
  try {
    sections = customSections(engine);
  } catch (error) {
    fail("ENGINE_INVALID", `${enginePath} is not a guest engine: ${error.message}`);
  }
  if (sections.some((s) => s.name === PROGRAM_SECTION))
    fail(
      "ENGINE_INVALID",
      `${enginePath} already carries a program (${PROGRAM_SECTION}); pass the bare engine`,
    );

  const eve = await eveOf(appRoot);
  let result;
  try {
    result = await eve.compileAgent({ startPath: appRoot });
  } catch (error) {
    fail(
      "AGENT_INVALID",
      `eve could not compile the agent at ${appRoot}: ${String(error?.message ?? error)}`,
    );
  }
  const compiled = { ...result, eveDist: eve.dist };
  const errors = compiled.diagnostics.filter((d) => d.severity === "error");
  if (errors.length)
    fail(
      "AGENT_INVALID",
      `eve's compiler reported ${errors.length} error(s):\n${errors.map((d) => `  ${d.message}`).join("\n")}`,
    );

  const keep = deriveKeep({ moduleMapPath: compiled.paths.moduleMapPath, eveDist: eve.dist });
  const producer = { name: "eve-appboundry", version: eve.version };
  const tools = agentTools(compiled, keep);
  const missingTools = tools.filter((t) => t.decision === "missing");
  if (missingTools.length)
    fail(
      "KEEP_INCOMPLETE",
      `the keep list has no module for these tools: ${missingTools.map((t) => t.tool).join(", ")}`,
    );
  const toolModules = Object.fromEntries(tools.filter((t) => t.path).map((t) => [t.tool, t.path]));
  const bundled = await bundleGuest({
    compiled,
    keep,
    toolModules,
    application: {
      id: declaration.application.id,
      producer: `${producer.name}/${producer.version}`,
    },
  });
  const { report } = bundled;
  if (report.nativeAsync > 0)
    fail(
      "PROGRAM_INVALID",
      `the program has ${report.nativeAsync} native async functions or awaits; the guest's async context needs them lowered`,
    );
  const unimplemented = report.staticGraph.nodeBuiltins.filter(
    (site) => !(site.builtin in report.implemented),
  );
  if (unimplemented.length)
    fail(
      "PROGRAM_INVALID",
      `the program's static graph imports Node built-ins the guest does not have:\n${unimplemented.map((s) => `  node:${s.builtin} <- ${s.importer}`).join("\n")}`,
    );
  const unbundled = report.kept.filter((k) => !k.bundled);
  if (unbundled.length)
    fail(
      "KEEP_INCOMPLETE",
      `kept modules missing from the bundle: ${unbundled.map((k) => k.module).join(", ")}`,
    );
  const unavailable = tools
    .map((t) => ({
      ...t,
      needs: (report.tools[t.tool]?.nodeBuiltins ?? []).filter(
        (site) => !(site.builtin in report.implemented),
      ),
    }))
    .filter((t) => t.needs.length);
  if (unavailable.length) {
    fail(
      "TOOL_UNAVAILABLE",
      [
        "these tools need Node built-ins the AppBoundry guest does not have, so the model could call them but they could not run:",
        ...unavailable.map(
          (t) =>
            `  ${t.tool} (${t.source}): ${[...new Set(t.needs.map((n) => `node:${n.builtin}`))].join(", ")}, from ${[...new Set(t.needs.map((n) => n.importer))].join(", ")}`,
        ),
        "Remove them from the agent: a default tool with `defaultTools: false` in agent.ts (or `export default disableTool()` in tools/<name>.ts), a declared one by deleting its file.",
      ].join("\n"),
      {
        agent: {
          name: compiled.manifest.config.name,
          tools: tools.map(({ path: _path, ...t }) => ({
            ...t,
            module: report.tools[t.tool]?.module ?? null,
            nodeBuiltins: report.tools[t.tool]?.nodeBuiltins ?? [],
          })),
        },
        keep: report.kept,
        stubbed: report.stubbed,
      },
    );
  }

  const program = new TextEncoder().encode(bundled.program);
  const module = appendCustomSection(engine, PROGRAM_SECTION, program);
  const omitted = [
    `model: ${compiled.manifest.config.model?.id ?? "none"} is a reference; the deployment's model@1 binding chooses the model and holds its credential`,
    "sandbox: AppBoundry has no sandbox host interface; a tool that needs one fails, naming the module it lacks",
    "channels: eve's HTTP channels are not served; the manifest's functions are the delivery surface",
  ];
  const manifest = artifactManifest({
    application: declaration.application,
    producer,
    module,
    program,
    requires: declaration.requires,
    omitted,
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const secrets = [
    ...findSecrets(bundled.program, "the program"),
    ...findSecrets(manifestText, "the manifest"),
  ];
  if (secrets.length)
    fail(
      "SECRET_IN_ARTIFACT",
      `the artifact would carry what looks like a credential:\n${secrets.map((s) => `  ${s}`).join("\n")}`,
    );
  for (const local of [appRoot, process.env.HOME].filter((p) => p && p.length > 1)) {
    if (bundled.program.includes(local) || manifestText.includes(local))
      fail("PROGRAM_INVALID", `the artifact names the build machine's path ${local}`);
  }

  if (existsSync(out) && !existsSync(join(out, "manifest.json")))
    fail("OUT_CONFLICT", `${out} exists and is not an artifact; refusing to replace it`);
  const staging = `${out}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "module.wasm"), module);
  writeFileSync(join(staging, "manifest.json"), manifestText);
  rmSync(out, { recursive: true, force: true });
  renameSync(staging, out);

  return {
    path: out,
    manifest,
    report: {
      application: declaration.application,
      producer,
      agent: {
        name: compiled.manifest.config.name,
        model: compiled.manifest.config.model?.id ?? null,
        tools: tools.map(({ path: _path, ...t }) => ({
          ...t,
          module: report.tools[t.tool]?.module ?? null,
          nodeBuiltins: report.tools[t.tool]?.nodeBuiltins ?? [],
        })),
      },
      interfaces: manifest.runtime.interfaces,
      requires: declaration.requires,
      bytes: { program: program.byteLength, module: module.byteLength, engine: engine.byteLength },
      keep: report.kept,
      stubbed: report.stubbed,
      staticGraph: report.staticGraph,
      implemented: report.implemented,
      engineWorkarounds: report.engineWorkarounds,
      nodeBuiltins: report.nodeBuiltins,
      buildMs: report.buildMs,
    },
  };
}

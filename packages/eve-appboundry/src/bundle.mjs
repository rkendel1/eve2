import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "acorn";
import { full } from "acorn-walk";

const GUEST = fileURLToPath(new URL("../guest/", import.meta.url));

const IMPLEMENTED = { module: join(GUEST, "node-module.js") };
export const GUEST_APP_ROOT = "/appboundry/agent";

const SHAPE_REDEFINE =
  /Object\.defineProperty\(\s*([\w$]+)\s*,\s*"shape"\s*,\s*\{\s*value\s*:\s*([\w$]+)\s*\}\s*\)/g;

const relocated = (path, appRoot) =>
  JSON.parse(
    readFileSync(path, "utf8").replaceAll(JSON.stringify(appRoot).slice(1, -1), GUEST_APP_ROOT),
  );

export async function bundleGuest({ compiled, keep, application, toolModules }) {
  const appRoot = compiled.paths.appRoot;
  const eveDist = compiled.eveDist;
  const name = (path) => {
    const abs = resolvePath(path);
    if (abs.startsWith(eveDist)) return `eve/dist/src/${relative(eveDist, abs)}`;
    if (abs.includes("/node_modules/")) return abs.replace(/.*node_modules\//, "");
    if (abs.startsWith(appRoot)) return `agent/${relative(appRoot, abs)}`;
    if (abs.startsWith(GUEST)) return `guest/${relative(GUEST, abs)}`;
    return abs;
  };
  const keepPaths = new Set(keep.map((k) => k.module));
  const builtins = new Map();
  const shapeRewrites = {};
  const dynamicStubs = new Map();
  let staticModules = new Set();
  let stubbing = false;

  const guestPlatform = {
    name: "eve-appboundry-guest",
    setup(b) {
      b.onResolve({ filter: /^\.\/agent\.js$/ }, (args) =>
        args.importer === join(GUEST, "entry.js")
          ? { path: "compiled-agent", namespace: "eve-agent" }
          : undefined,
      );
      b.onLoad({ filter: /.*/, namespace: "eve-agent" }, () => {
        const json = (path) => JSON.stringify(relocated(path, appRoot));
        return {
          contents: [
            `import loadModuleMap from ${JSON.stringify(compiled.paths.moduleMapPath)};`,
            `const manifest = ${json(compiled.paths.compiledManifestPath)};`,
            `const metadata = ${json(compiled.paths.compileMetadataPath)};`,
            `const modelMetadata = ${json(compiled.paths.modelMetadataPath)};`,
            `const sandboxPreparedArtifacts = ${json(compiled.paths.sandboxPreparedArtifactsPath)};`,
            `export const loadAgent = async () => ({ manifest, metadata, modelMetadata, moduleMap: await loadModuleMap, sandboxPreparedArtifacts });`,
          ].join("\n"),
          loader: "js",
          resolveDir: GUEST,
        };
      });
      b.onLoad({ filter: /\.eve\/compile\/module-map\.mjs$/, namespace: "file" }, (args) => {
        const lines = readFileSync(args.path, "utf8").split("\n");
        const imports = lines.filter((line) => line.startsWith("import "));
        const body = lines
          .filter((line) => !line.startsWith("import "))
          .join("\n")
          .replace(/export default moduleMap;\s*$/, "return moduleMap;")
          .replace(/^export const moduleMap =/m, "const moduleMap =");
        return {
          contents: `${imports.join("\n")}\nexport default (async () => {\n${body}\n})();\n`,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
      b.onLoad({ filter: /\.(m|c)?js$/, namespace: "file" }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!source.includes('"shape"')) return undefined;
        let count = 0;
        const contents = source.replace(SHAPE_REDEFINE, (_match, target, value) => {
          count += 1;
          return `globalThis.__abgConstShape(${target}, ${value})`;
        });
        if (count === 0) return undefined;
        shapeRewrites[name(args.path)] = count;
        return { contents, loader: "js", resolveDir: dirname(args.path) };
      });
      b.onResolve({ filter: /^eve(\/.*)?$/ }, (args) =>
        args.importer.startsWith(GUEST) && !args.pluginData?.fromApp
          ? b.resolve(args.path, {
              kind: args.kind,
              resolveDir: appRoot,
              pluginData: { fromApp: true },
            })
          : undefined,
      );
      b.onResolve({ filter: /^#context\/container\.js$/ }, (args) =>
        args.importer.startsWith(GUEST)
          ? { path: join(eveDist, "context/container.js") }
          : undefined,
      );
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (
          !stubbing ||
          args.kind !== "dynamic-import" ||
          args.pluginData?.dynamicStub ||
          isBuiltin(args.path)
        )
          return undefined;
        const resolved = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { dynamicStub: true },
        });
        if (
          resolved.errors.length ||
          resolved.external ||
          staticModules.has(resolved.path) ||
          keepPaths.has(resolved.path)
        )
          return undefined;
        const stubbed = name(resolved.path);
        if (!dynamicStubs.has(stubbed)) dynamicStubs.set(stubbed, new Set());
        dynamicStubs.get(stubbed).add(name(args.importer));
        return { path: stubbed, namespace: "eve-dynamic-stub" };
      });
      b.onLoad({ filter: /.*/, namespace: "eve-dynamic-stub" }, (args) => ({
        contents: `throw new Error(${JSON.stringify(`${args.path} is loaded only on demand and is not part of the AppBoundry guest bundle (the agent declares nothing that keeps it)`)});\n`,
        loader: "js",
      }));
      b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        if (!isBuiltin(args.path)) return undefined;
        const builtin = args.path.replace(/^node:/, "");
        if (!builtins.has(builtin)) builtins.set(builtin, []);
        builtins.get(builtin).push({ importer: name(args.importer), kind: args.kind });
        if (IMPLEMENTED[builtin]) return { path: IMPLEMENTED[builtin] };
        return { path: builtin, namespace: "eve-node-stub" };
      });
      b.onLoad({ filter: /.*/, namespace: "eve-node-stub" }, (args) => ({
        contents: `module.exports = require(${JSON.stringify(join(GUEST, "node/stub.cjs"))})(${JSON.stringify(`node:${args.path}`)});\n`,
        loader: "js",
        resolveDir: GUEST,
      }));
    },
  };

  const options = {
    entryPoints: [join(GUEST, "entry.js")],
    absWorkingDir: GUEST,
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["browser", "import", "default"],
    target: "es2022",
    supported: { "async-await": false, "async-generator": false, "for-await": false },
    outfile: join(GUEST, "program.js"),
    plugins: [guestPlatform],
    loader: { ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.url": '"file:///appboundry/guest/eve.js"',
      __EVE_APPLICATION__: JSON.stringify(application),
    },
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
  };
  const started = performance.now();
  staticModules = entryGraph((await build(options)).metafile.inputs);
  stubbing = true;
  builtins.clear();
  const result = await build(options);
  const program = result.outputFiles
    .find((file) => file.path.endsWith(".js"))
    .text.replaceAll(appRoot, GUEST_APP_ROOT);

  let nativeAwait = 0;
  full(parse(program, { ecmaVersion: "latest" }), (node) => {
    if (
      node.type === "AwaitExpression" ||
      (node.type === "ForOfStatement" && node.await) ||
      (/Function/.test(node.type) && node.async)
    )
      nativeAwait += 1;
  });
  const inputs = result.metafile.inputs;
  const keyOf = new Map(Object.keys(inputs).map((key) => [absolute(key), key]));
  const entry = keyOf.get(join(GUEST, "entry.js"));
  const toolKeys = new Map(
    Object.entries(toolModules).map(([tool, path]) => [tool, keyOf.get(path)]),
  );
  const stopAt = new Set(toolKeys.values());
  const core = closure(inputs, [entry], stopAt);
  const report = {
    bytes: Buffer.byteLength(program),
    buildMs: Math.round(performance.now() - started),
    nativeAsync: nativeAwait,
    staticGraph: { modules: core.size, nodeBuiltins: builtinSites(inputs, core, name) },
    tools: Object.fromEntries(
      [...toolKeys].map(([tool, key]) => {
        if (key === undefined) return [tool, { module: null, nodeBuiltins: [] }];
        return [
          tool,
          {
            module: name(absolute(key)),
            nodeBuiltins: builtinSites(inputs, closure(inputs, [key], new Set()), name),
          },
        ];
      }),
    ),
    implemented: Object.fromEntries(Object.entries(IMPLEMENTED).map(([k, v]) => [k, name(v)])),
    kept: keep.map((k) => ({
      module: name(k.module),
      reason: k.reason,
      from: k.from,
      bundled: keyOf.has(k.module),
    })),
    stubbed: Object.fromEntries(
      [...dynamicStubs].sort().map(([module, importers]) => [module, [...importers].sort()]),
    ),
    engineWorkarounds: { zodShapeRedefinitions: shapeRewrites },
    nodeBuiltins: Object.fromEntries(
      [...builtins].sort().map(([builtin, sites]) => [builtin, sites]),
    ),
  };
  return { program, report };
}

const absolute = (key) => (/^[a-z-]+:/.test(key) ? key : resolvePath(GUEST, key));

function closure(inputs, roots, stopAt) {
  const seen = new Set();
  for (const queue = [...roots]; queue.length > 0;) {
    const at = queue.shift();
    if (seen.has(at) || (stopAt.has(at) && !roots.includes(at))) continue;
    seen.add(at);
    for (const edge of inputs[at]?.imports ?? [])
      if (edge.kind !== "dynamic-import" && !edge.external) queue.push(edge.path);
  }
  return seen;
}

function builtinSites(inputs, graph, name) {
  const sites = [];
  for (const key of graph) {
    for (const edge of inputs[key]?.imports ?? []) {
      if (edge.kind === "dynamic-import") continue;
      const builtin = edge.path.startsWith("eve-node-stub:")
        ? edge.path.slice("eve-node-stub:".length)
        : Object.entries(IMPLEMENTED).find(([, file]) => absolute(edge.path) === file)?.[0];
      if (builtin !== undefined) sites.push({ builtin, importer: name(absolute(key)) });
    }
  }
  return sites.sort((a, b) =>
    `${a.builtin} ${a.importer}`.localeCompare(`${b.builtin} ${b.importer}`),
  );
}

function entryGraph(inputs) {
  const entry = Object.keys(inputs).find((key) => absolute(key) === join(GUEST, "entry.js"));
  return new Set([...closure(inputs, [entry], new Set())].map(absolute));
}

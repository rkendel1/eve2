#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = process.argv[2] ?? "src/execution/session/turn-step.ts";
const HOSTING_ONLY = [
  /[\\/]undici[\\/]/,
  /[\\/]rolldown[\\/]/,
  /[\\/]compiled[\\/]@workflow[\\/]/,
  /[\\/]nitro[\\/]/,
];
const edges = new Map();
const forbidden = new Map();
const lazy = new Map();
const sites = new Set();
const isBuiltin = (id) =>
  id.startsWith("node:") ||
  /^(fs|path|os|crypto|util|events|stream|url|http|https|net|tls|zlib|buffer|module|assert|child_process|worker_threads|async_hooks|perf_hooks|querystring|string_decoder|dns|tty|readline|vm|diagnostics_channel|process|timers|console|constants|http2|inspector|v8|sqlite)(\/.*)?$/.test(
    id,
  );

const bundle = await rolldown({
  input: `${root}/${entry}`,
  cwd: root,
  platform: "neutral",
  logLevel: "silent",
  resolve: {
    conditionNames: ["eve-source", "browser", "import", "default"],
    mainFields: ["module", "main"],
  },
  plugins: [
    {
      name: "host-neutral-graph",
      async resolveId(source, importer, options) {
        if (options?.kind === "dynamic-import" && importer) {
          if (!lazy.has(source)) lazy.set(source, importer);
          return { id: `\0lazy:${source}`, external: true };
        }
        if (isBuiltin(source)) {
          const name = source.replace(/^node:/, "");
          if (!forbidden.has(name)) forbidden.set(name, importer);
          sites.add(`${name}\t${importer}`);
          return { id: `\0builtin:${name}`, external: true };
        }
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved && importer && !edges.has(resolved.id)) edges.set(resolved.id, importer);
        if (resolved && HOSTING_ONLY.some((p) => p.test(resolved.id))) {
          const name = resolved.id
            .replace(/.*node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?/, "")
            .replace(/.*[\\/]compiled[\\/]/, "compiled/")
            .split(/[\\/]/)
            .slice(0, 2)
            .join("/");
          if (!forbidden.has(name)) forbidden.set(name, importer);
          return { id: resolved.id, external: true };
        }
        return resolved;
      },
    },
  ],
});
const { output } = await bundle.generate({ format: "esm" });
const bytes = output.filter((o) => o.type === "chunk").reduce((n, o) => n + o.code.length, 0);
const short = (id) =>
  (id ?? "")
    .replace(root, "")
    .replace(/^[\\/]/, "")
    .replace(/.*node_modules[\\/]/, "");
const chain = (importer) => {
  const path = [];
  for (let id = importer, n = 0; id && n < 40; id = edges.get(id), n++) path.unshift(short(id));
  return path.join(" > ");
};
console.log(`${entry}: ${(bytes / 1024).toFixed(0)} KiB bundled for a neutral platform`);
for (const [name, importer] of [...forbidden].sort())
  console.log(`  ${name.padEnd(22)} ${chain(importer)}`);
if (process.argv.includes("--sites"))
  for (const site of [...sites].sort()) {
    const [name, importer] = site.split("\t");
    console.log(`  site ${name.padEnd(16)} ${short(importer)}`);
  }
if (process.argv.includes("--lazy"))
  for (const [source, importer] of [...lazy].sort())
    console.log(`  lazy ${source.padEnd(40)} from ${short(importer)}`);
if (forbidden.size > 0) {
  console.error(
    `\n${forbidden.size} Node built-in or hosting-only dependencies are reachable from ${entry}.`,
  );
  process.exitCode = 1;
}

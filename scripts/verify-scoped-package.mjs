import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedPackage } from "./scoped-packages.mjs";

const [tarball, key = "eve"] = process.argv.slice(2);
if (!tarball) throw new Error("Usage: node scripts/verify-scoped-package.mjs <tarball> [package]");
const entry = scopedPackage(key);
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const listing = run("tar", ["-tzf", tarball])
  .split("\n")
  .filter(Boolean)
  .map((path) => path.replace(/^package\//, ""));
const missing = (entry.requiredFiles ?? ["LICENSE", "package.json"]).filter(
  (file) => !listing.includes(file),
);
if (missing.length) throw new Error(`${tarball} is missing ${missing.join(", ")}`);

const project = mkdtempSync(join(tmpdir(), "eve-clean-install-"));
try {
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "clean-install",
      private: true,
      type: "module",
      dependencies: { ...entry.smokeDependencies, [entry.name]: `file:${tarball}` },
    }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], project);
  const installed = JSON.parse(
    readFileSync(join(project, "node_modules", entry.name, "package.json"), "utf8"),
  );
  if (installed.name !== entry.name)
    throw new Error(`installed ${installed.name}, expected ${entry.name}`);
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  if (installed.gitHead !== commit)
    throw new Error(`the package was packed from ${installed.gitHead}, not HEAD ${commit}`);
  let smoke = null;
  if (entry.smoke) {
    writeFileSync(join(project, "smoke.mjs"), entry.smoke);
    smoke = JSON.parse(run(process.execPath, ["smoke.mjs"], project).trim().split("\n").at(-1));
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, name: entry.name, version: installed.version, commit, files: listing.length, smoke }, null, 2)}\n`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scopedPackage } from "./scoped-packages.mjs";

const args = process.argv.slice(2);
const packageFlag = args.indexOf("--package");
const key = packageFlag >= 0 ? args.splice(packageFlag, 2)[1] : "eve";
const entry = scopedPackage(key);
const [name, version, out = "."] = args;
if (!name?.startsWith("@") || !name.includes("/") || !version) {
  throw new Error(
    `Usage: node scripts/pack-scoped-eve.mjs <@scope/name> <version> [out-dir] [--package ${Object.keys((await import("./scoped-packages.mjs")).SCOPED_PACKAGES).join("|")}]. Run \`pnpm --filter ${entry.workspace} build\` first; this packs ${entry.staged}.`,
  );
}
const staged = resolve(entry.staged);
const manifest = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
if (manifest.name !== entry.workspace) {
  throw new Error(
    `${staged} is not the staged ${entry.workspace} package (it names ${manifest.name}).`,
  );
}
if (manifest.version !== version) {
  throw new Error(
    `The staged ${entry.workspace} package is ${manifest.version}, not ${version}. Set ${entry.directory}'s version to ${version} (pnpm version-packages), commit, run pnpm --filter ${entry.workspace} build, then pack.`,
  );
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", entry.directory], {
  encoding: "utf8",
}).trim();
if (dirty) throw new Error(`${entry.directory} has uncommitted changes; pack a commit:\n${dirty}`);

const work = await mkdtemp(join(tmpdir(), "eve-scoped-"));
try {
  const files =
    entry.staged === entry.directory ? ["package.json", ...(manifest.files ?? [])] : null;
  if (files) {
    for (const file of files) await cp(join(staged, file), join(work, file), { recursive: true });
  } else {
    await cp(staged, work, { recursive: true });
  }
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    private: _private,
    ...published
  } = manifest;
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify(
      {
        ...(files ? published : manifest),
        name,
        version,
        repository: {
          type: "git",
          url: "git+https://github.com/rkendel1/eve2.git",
          directory: entry.directory,
        },
        gitHead: commit,
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", resolve(out)],
      {
        cwd: work,
        encoding: "utf8",
      },
    ),
  )[0];
  process.stdout.write(
    `${JSON.stringify({ tarball: join(resolve(out), packed.filename), name, version, commit, integrity: packed.integrity, files: packed.entryCount, paths: packed.files.map((file) => file.path) }, null, 2)}\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

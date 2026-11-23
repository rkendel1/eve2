import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [name, version, out = "."] = process.argv.slice(2);
if (!name?.startsWith("@") || !name.includes("/") || !version) {
  throw new Error(
    "Usage: node scripts/pack-scoped-eve.mjs <@scope/name> <version> [out-dir]. Run `pnpm --filter eve build` first; this packs its staged packages/eve/.package.",
  );
}
const staged = resolve("packages/eve/.package");
const manifest = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
if (manifest.name !== "eve") {
  throw new Error(`${staged} is not the staged eve package (it names ${manifest.name}).`);
}
if (manifest.version !== version) {
  throw new Error(
    `The staged eve package is ${manifest.version}, not ${version}. Its dist is stamped with the version it was built as, and a package that declares another version fails at startup. Set packages/eve's version to ${version} (pnpm version-packages), commit, run pnpm --filter eve build, then pack.`,
  );
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages/eve"], {
  encoding: "utf8",
}).trim();
if (dirty) throw new Error(`packages/eve has uncommitted changes; pack a commit:\n${dirty}`);

const work = await mkdtemp(join(tmpdir(), "eve-scoped-"));
try {
  await cp(staged, work, { recursive: true });
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify(
      {
        ...manifest,
        name,
        version,
        repository: {
          type: "git",
          url: "git+https://github.com/rkendel1/eve2.git",
          directory: "packages/eve",
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
    `${JSON.stringify({ tarball: join(resolve(out), packed.filename), name, version, commit, integrity: packed.integrity, files: packed.entryCount }, null, 2)}\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

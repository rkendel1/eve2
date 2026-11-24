import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedPackage } from "./scoped-packages.mjs";

const args = process.argv.slice(2);
const packageFlag = args.indexOf("--package");
const key = packageFlag >= 0 ? args[packageFlag + 1] : "eve";
const entry = scopedPackage(key);
const NAME = entry.name;
const dryRun = args.includes("--dry-run");
const versionFlag = args.indexOf("--version");
const version =
  versionFlag >= 0
    ? args[versionFlag + 1]
    : JSON.parse(readFileSync(join(entry.directory, "package.json"), "utf8")).version;
if (!version || version.startsWith("-"))
  throw new Error("--version needs a value, e.g. --version 1.0.3.");

const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN ?? "";
if (!dryRun && token === "") {
  throw new Error(
    "No npm token: set NPM_TOKEN in .env.local (or NODE_AUTH_TOKEN in CI). It needs read-write access to @appport and must not require a one-time password (a granular token with 'Bypass two-factor authentication', or an Automation token).",
  );
}

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const published = (() => {
  try {
    return run("npm", ["view", `${NAME}@${version}`, "version"]).trim() === version;
  } catch {
    return false;
  }
})();
if (published) {
  throw new Error(
    `${NAME}@${version} is already published. Publish a new version: npm run publish:packages -- --package ${key} --version <next>.`,
  );
}

process.stdout.write(`▸ build ${entry.workspace} (${entry.directory})\n`);
execFileSync("pnpm", ["--filter", entry.workspace, "build"], { stdio: "inherit" });

const out = mkdtempSync(join(tmpdir(), "eve-publish-"));
const npmrc = join(out, ".npmrc");
try {
  process.stdout.write(`▸ pack ${NAME}@${version}\n`);
  const packed = JSON.parse(
    run("node", ["scripts/pack-scoped-eve.mjs", NAME, version, out, "--package", key]),
  );
  process.stdout.write(`  ${packed.tarball}\n  commit ${packed.commit}\n  ${packed.integrity}\n`);
  process.stdout.write(`▸ clean install and license check\n`);
  run("node", ["scripts/verify-scoped-package.mjs", packed.tarball, key]);
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`, { mode: 0o600 });
  process.stdout.write(`▸ ${dryRun ? "dry run: " : ""}publish ${NAME}@${version}\n`);
  try {
    execFileSync(
      "npm",
      [
        "publish",
        packed.tarball,
        "--access",
        "public",
        "--userconfig",
        npmrc,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ["ignore", "inherit", "pipe"] },
    );
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    process.stderr.write(stderr);
    if (/EOTP|one-time password/i.test(stderr)) {
      throw new Error(
        "npm asked for a one-time password: this token cannot publish without 2FA. Use a granular token with 'Bypass two-factor authentication' (read-write on @appport) or an Automation token.",
      );
    }
    throw new Error(`npm publish failed for ${NAME}@${version}.`);
  }
  process.stdout.write(
    dryRun
      ? `✓ dry run complete; nothing was published\n`
      : `✓ published ${NAME}@${version}.${entry.consumerAlias ? ` Consumers install it as "${entry.consumerAlias}": "npm:${NAME}@${version}".` : ""}\n`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}

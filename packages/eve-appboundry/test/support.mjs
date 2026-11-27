import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { produce } from "../src/produce.mjs";

export const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
export const fixture = (name) => join(PACKAGE, "fixtures", name);
export const ENGINE = process.env.EVE_APPBOUNDRY_ENGINE;
export const CHECKOUT = process.env.APPBOUNDRY_CHECKOUT;
export const needsEngine =
  ENGINE && existsSync(ENGINE)
    ? false
    : "set EVE_APPBOUNDRY_ENGINE to @feltdb/feltkit's appboundry/engine.wasm";
export const needsAppBoundry =
  needsEngine ||
  (CHECKOUT &&
  existsSync(join(CHECKOUT, "packages/appboundry-host/dist/index.js")) &&
  existsSync(join(CHECKOUT, "packages/appboundry/dist/bin.js"))
    ? false
    : "set APPBOUNDRY_CHECKOUT to a built rkendel1/appboundry checkout");
export const APPBOUNDRY_CLI = CHECKOUT ? join(CHECKOUT, "packages/appboundry/dist/bin.js") : null;

const dirs = [];
export const scratch = (prefix = "eve-appboundry-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
export const cleanup = () =>
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));

const built = new Map();
export const artifactOf = (name) => {
  if (!built.has(name))
    built.set(
      name,
      produce({ appRoot: fixture(name), engine: ENGINE, out: join(scratch(), `${name}.app`) }),
    );
  return built.get(name);
};

export const hostModule = () =>
  import(pathToFileURL(join(CHECKOUT, "packages/appboundry-host/dist/index.js")).href);

export async function hostDependency(name) {
  const [scope, pkg, ...rest] = name.split("/");
  const root = realpathSync(join(CHECKOUT, "packages/appboundry-host/node_modules", scope, pkg));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entry = manifest.exports[rest.length ? `./${rest.join("/")}` : "."];
  return import(
    pathToFileURL(join(root, typeof entry === "string" ? entry : (entry.import ?? entry.default)))
      .href
  );
}

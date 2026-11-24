import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
}

let cached: PackageInfo | undefined;

export async function getPackageInfo(): Promise<PackageInfo> {
  if (cached) return cached;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(moduleDir, candidate), "utf8"),
      ) as PackageInfo;
      if (parsed.name === "@appport/eve-world-feltdb") {
        cached = { name: parsed.name, version: parsed.version };
        return cached;
      }
    } catch {
      continue;
    }
  }
  cached = { name: "@appport/eve-world-feltdb", version: "0.0.0" };
  return cached;
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(path.resolve(dataDir), { recursive: true });
}

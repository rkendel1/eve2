import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function evePackageInfo(): { readonly name: string; readonly version: string } {
  return resolveInstalledPackageInfo();
}

export function eveVersion(): string {
  return resolveInstalledPackageInfo().version;
}

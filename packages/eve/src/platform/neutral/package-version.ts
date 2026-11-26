import { readStampedPackageVersion } from "#internal/application/stamped-package-version.js";

export function evePackageInfo(): { readonly name: string; readonly version: string } {
  return { name: "eve", version: eveVersion() };
}

export function eveVersion(): string {
  return readStampedPackageVersion() ?? "unstamped";
}

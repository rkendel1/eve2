export const EVE_PACKAGE_NAME = "eve";

const EVE_DISTRIBUTION_NAMES: ReadonlySet<string> = new Set([EVE_PACKAGE_NAME, "@appport/eve"]);

export function canonicalPackageName(name: string): string {
  return EVE_DISTRIBUTION_NAMES.has(name) ? EVE_PACKAGE_NAME : name;
}

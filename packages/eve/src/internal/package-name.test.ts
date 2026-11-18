import { describe, expect, it } from "vitest";

import { canonicalPackageName, EVE_PACKAGE_NAME } from "#internal/package-name.js";

describe("canonicalPackageName", () => {
  it("names eve's published distribution as eve, so an aliased install resolves and verifies as eve", () => {
    expect(canonicalPackageName("@appport/eve")).toBe(EVE_PACKAGE_NAME);
    expect(canonicalPackageName("eve")).toBe(EVE_PACKAGE_NAME);
  });

  it("leaves every other package name unchanged", () => {
    expect(canonicalPackageName("@appport/eve-extra")).toBe("@appport/eve-extra");
    expect(canonicalPackageName("evelyn")).toBe("evelyn");
    expect(canonicalPackageName("@other/eve")).toBe("@other/eve");
  });
});

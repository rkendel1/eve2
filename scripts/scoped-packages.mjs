export const SCOPED_PACKAGES = {
  eve: {
    name: "@appport/eve",
    workspace: "eve",
    directory: "packages/eve",
    staged: "packages/eve/.package",
    consumerAlias: "eve",
  },
  "world-feltdb": {
    name: "@appport/eve-world-feltdb",
    workspace: "@appport/eve-world-feltdb",
    directory: "packages/eve-world-feltdb",
    staged: "packages/eve-world-feltdb",
    requiredFiles: ["LICENSE", "NOTICE", "README.md", "dist/index.js", "dist/index.d.ts"],
    smoke: `
      import { createFeltDB } from "@feltdb/core";
      import { feltdbRecordPayloads } from "@appport/eve-world-feltdb";
      const db = createFeltDB({ memory: true, namespace: "smoke" });
      const store = feltdbRecordPayloads({ db });
      const ref = await store.write(new TextEncoder().encode("clean install"));
      if (new TextDecoder().decode(await store.read(ref)) !== "clean install") throw new Error("round trip failed");
      console.log(JSON.stringify({ ok: true, ref }));
    `,
    smokeDependencies: { "@feltdb/core": "0.23.0" },
  },
};

export function scopedPackage(key) {
  const entry = SCOPED_PACKAGES[key];
  if (!entry) {
    throw new Error(
      `Unknown package "${key}". Publishable packages: ${Object.keys(SCOPED_PACKAGES).join(", ")}.`,
    );
  }
  return entry;
}

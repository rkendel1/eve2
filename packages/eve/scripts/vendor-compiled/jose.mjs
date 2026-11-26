import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "jose",
  platform: "neutral",
  compiledPath: "jose",
  declaration: await loadDeclaration("jose.d.ts"),
};

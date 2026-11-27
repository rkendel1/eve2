import { join } from "node:path";
import { frameworkModules, moduleMapEntries, REGISTRY_FILES } from "./module-map.mjs";

export const HOST_BASE = [
  {
    module: "definitions/compiled-agent.js",
    reason:
      "every session turn loads the compiled agent (runtime/sessions/compiled-session-agent.js)",
  },
  {
    module: "execution/sandbox/ensure.js",
    reason:
      "the sandbox context provider resolves sandbox access on every turn (context/providers/sandbox.js)",
  },
];

export function deriveKeep({ moduleMapPath, eveDist }) {
  const registry = frameworkModules(eveDist);
  const keep = new Map(
    HOST_BASE.map(({ module, reason }) => [
      join(eveDist, module),
      { module: join(eveDist, module), reason, from: ["host base"] },
    ]),
  );
  for (const entry of moduleMapEntries(moduleMapPath)) {
    if (entry.kind !== "programmatic") continue;
    const path = registry.get(entry.backing.moduleId);
    if (path === undefined) {
      throw new Error(
        `the compiled agent loads ${entry.key} (agent node ${entry.node}), which eve's framework registry (${REGISTRY_FILES.join(", ")}) does not name; the producer cannot tell which module to keep`,
      );
    }
    const existing = keep.get(path);
    if (existing) existing.from = [...new Set([...existing.from, entry.key])];
    else
      keep.set(path, {
        module: path,
        reason: `the compiled agent's module map loads ${entry.key}`,
        from: [entry.key],
      });
  }
  return [...keep.values()];
}

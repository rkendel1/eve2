import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "acorn";
import { full } from "acorn-walk";

export const REGISTRY_FILES = [
  "framework/sources/registry.js",
  "framework/sources/default-tools.js",
];

const text = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : undefined;
const property = (object, name) =>
  object.properties.find((p) => p.type === "Property" && (p.key.name ?? p.key.value) === name)
    ?.value;

export function frameworkModules(eveDist) {
  const modules = new Map();
  for (const file of REGISTRY_FILES) {
    const ast = parse(readFileSync(join(eveDist, file), "utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    full(ast, (node) => {
      if (node.type !== "ObjectExpression") return;
      const logicalPath = text(property(node, "logicalPath"));
      const load = property(node, "loadNamespace");
      if (
        logicalPath === undefined ||
        load?.type !== "ArrowFunctionExpression" ||
        load.body.type !== "ImportExpression"
      )
        return;
      const specifier = text(load.body.source);
      if (!specifier?.startsWith("#") || /^#(platform|compiled)\//.test(specifier)) {
        throw new Error(
          `eve's registry (${file}) loads ${logicalPath} from ${String(specifier)}, which is not a #<path>.js module of eve's dist`,
        );
      }
      const path = join(eveDist, specifier.slice(1));
      if (modules.has(logicalPath) && modules.get(logicalPath) !== path)
        throw new Error(
          `eve's registry names ${logicalPath} twice, as ${modules.get(logicalPath)} and ${path}`,
        );
      modules.set(logicalPath, path);
    });
  }
  if (modules.size === 0)
    throw new Error(
      `no modules found in eve's registry (${REGISTRY_FILES.join(", ")}); eve's dist layout changed`,
    );
  return modules;
}

export function moduleMapEntries(moduleMapPath) {
  const ast = parse(readFileSync(moduleMapPath, "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const imported = new Map();
  const locals = new Map();
  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier" && statement.source.value.startsWith("."))
          imported.set(specifier.local.name, resolve(moduleMapPath, "..", statement.source.value));
      }
    }
  }
  full(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || node.init === null)
      return;
    const call = node.init.type === "AwaitExpression" ? node.init.argument : node.init;
    if (call?.type !== "CallExpression") return;
    if (
      call.callee.name === "loadProgrammaticModule" &&
      call.arguments[0]?.type === "ObjectExpression"
    ) {
      const backing = Object.fromEntries(
        call.arguments[0].properties.map((p) => [p.key.value ?? p.key.name, p.value.value]),
      );
      locals.set(node.id.name, { kind: "programmatic", backing });
      return;
    }
    let inner = call;
    while (inner?.type === "CallExpression" && inner.arguments[0]?.type === "CallExpression")
      inner = inner.arguments[0];
    const name = inner?.arguments?.[0]?.name;
    if (imported.has(name))
      locals.set(node.id.name, { kind: "authored", path: imported.get(name) });
  });
  const entries = [];
  full(ast, (node) => {
    if (
      node.type !== "Property" ||
      (node.key.value ?? node.key.name) !== "nodes" ||
      node.value.type !== "CallExpression"
    )
      return;
    for (const agentNode of node.value.arguments[0].properties) {
      const modules = property(agentNode.value.arguments[0], "modules").arguments[0];
      for (const entry of modules.properties) {
        const local = locals.get(entry.value.name);
        if (!local)
          throw new Error(
            `the module map binds ${entry.key.value} to ${entry.value.name}, which it neither imports nor loads`,
          );
        entries.push({ node: agentNode.key.value, key: entry.key.value, ...local });
      }
    }
  });
  return entries;
}

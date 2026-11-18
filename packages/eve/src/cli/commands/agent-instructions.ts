import { readFileSync } from "node:fs";
import { join } from "node:path";

import pc from "#compiled/picocolors/index.js";

import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { parseModelHelper, type ModelHelper } from "#shared/model-helper.js";

export const SETUP_SECTIONS = [
  "intro-setup.md",
  "collect-intent.md",
  "vercel-connect.md",
  "scaffold.md",
  "build-and-verify.md",
] as const;

export const HANDOFF_SECTIONS = [
  "intro-handoff.md",
  "collect-intent.md",
  "vercel-connect.md",
  "build-and-verify.md",
] as const;

function compose(
  sections: readonly string[],
  options: { devCommand: string; workingDirectory?: string },
): string {
  const prompt = sections
    .map((section) =>
      readFileSync(new URL(`./agent-prompt/${section}`, import.meta.url), "utf8").trim(),
    )
    .join("\n\n")
    .replaceAll("{{devCommand}}", () => options.devCommand);
  const { workingDirectory } = options;
  if (workingDirectory === undefined) {
    return prompt;
  }
  return prompt.replaceAll("{{workingDirectory}}", () => workingDirectory);
}

export function initAgentInstructions(): string {
  return compose(SETUP_SECTIONS, { devCommand: "npx eve dev" });
}

export function initAgentReadySummary(
  model: string | undefined,
  projectPath: string,
  options: { workspace?: boolean } = {},
): string {
  const selectedModel = model ?? DEFAULT_AGENT_MODEL_ID;
  const defaultLabel = model === undefined ? pc.dim(" (eve default)") : "";
  const authoredFiles = options.workspace
    ? `${pc.green("✓")} Agents ${pc.bold(join(projectPath, "agents"))}`
    : `${pc.green("✓")} Instructions ${pc.bold(join(projectPath, "agent/instructions.md"))}`;
  return [
    `${pc.green("✓")} Model ${pc.bold(selectedModel)}${defaultLabel}`,
    `  ${pc.dim(describeModelRouting(selectedModel))}`,
    authoredFiles,
  ].join("\n");
}

const DIRECT_MODEL_ROUTING: Record<ModelHelper, string> = {
  chatgpt: "Calls ChatGPT through your /login subscription; local development only.",
  openai: "Calls OpenAI directly with OPENAI_API_KEY.",
  anthropic: "Calls Anthropic directly with ANTHROPIC_API_KEY.",
};

export function describeModelRouting(selection: string): string {
  const helper = parseModelHelper(selection)?.helper;
  if (helper !== undefined) return DIRECT_MODEL_ROUTING[helper];
  return "Routes through Vercel AI Gateway with AI_GATEWAY_API_KEY or Vercel OIDC. To call a provider directly, run `eve set model anthropic-api/claude-sonnet-5` or `eve set model openai-api/gpt-6-luna-fast`.";
}

export function initAgentDevHandoff(options: { projectPath: string; devCommand: string }): string {
  return compose(HANDOFF_SECTIONS, {
    devCommand: options.devCommand,
    workingDirectory: options.projectPath,
  });
}

export function initExtensionInstructions(): string {
  return [
    "You are scaffolding an eve extension package (a reusable package of tools,",
    "connections, skills, and hooks that a consuming agent mounts under",
    "agent/extensions/).",
    "",
    "Ask the user for a package directory name, then run:",
    "",
    "    npx eve@latest extension init <name>",
    "",
    "That creates the package, installs dependencies, and initializes Git. It",
    "prints what was set up and how to author, build, and mount the extension —",
    "it does not start eve dev (extensions are not standalone agents).",
    "",
    "Build with `eve extension build` (or the package `build` script).",
  ].join("\n");
}

export function initExtensionHandoff(options: {
  packageManager: string;
  packageName: string;
  projectPath: string;
}): string {
  const buildCommand = `${options.packageManager} run build`;
  return [
    "",
    "What we set up:",
    "  - package.json with eve.extension source/dist roots, peer+dev eve, and zod",
    "  - extension/extension.ts (config schema via defineExtension)",
    "  - build/prepare scripts → eve extension build",
    "",
    "Next:",
    "  - Add tools, skills, hooks, or connections under extension/",
    "    (see AGENTS.md and node_modules/eve/docs/extensions/index.md)",
    `  - ${buildCommand}   # builds dist/extension and package exports`,
    "  - Mount from a consumer agent:",
    `      // agent/extensions/${options.packageName}.ts`,
    `      import ext from "${options.packageName}";`,
    "      export default ext({ apiKey: process.env.API_KEY });",
    "",
    `Working directory: ${options.projectPath}`,
  ].join("\n");
}

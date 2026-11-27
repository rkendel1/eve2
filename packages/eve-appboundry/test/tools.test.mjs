import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { produce } from "../src/produce.mjs";
import {
  artifactOf,
  cleanup,
  ENGINE,
  needsAppBoundry,
  needsEngine,
  PACKAGE,
  scratch,
} from "./support.mjs";
import {
  bindings,
  closeServers,
  deliverArgs,
  hostProcess,
  listen,
  provider,
  scriptedModel,
} from "./support/production.mjs";

const reexport = (name) => `export { default } from "eve/tools/${name}";\n`;
const named = (module, name, call = name) =>
  `import { ${name} } from "eve/tools/${module}";\n\nexport default ${call};\n`;
const TOOLS = {
  bash: reexport("bash"),
  read_file: reexport("read_file"),
  write_file: reexport("write_file"),
  edit_file: reexport("edit_file"),
  glob: reexport("glob"),
  grep: reexport("grep"),
  web_fetch: reexport("web_fetch"),
  web_search: named("web_search", "webSearch", 'webSearch({ provider: "parallel" })'),
  agent: reexport("agent"),
  sleep: named("sleep", "sleep"),
  ask_question: named("ask_question", "askQuestion"),
  no_reply: named("no_reply", "noReply"),
};

const root = join(PACKAGE, ".tool-inventory");
async function buildWith(tool) {
  const app = join(root, tool);
  mkdirSync(join(app, "tools"), { recursive: true });
  writeFileSync(
    join(app, "agent.ts"),
    'import { defineAgent } from "eve";\n\nexport default defineAgent({ defaultTools: false, model: "anthropic/claude-sonnet-5" });\n',
  );
  writeFileSync(join(app, "instructions.md"), "You help Alice.\n");
  writeFileSync(
    join(app, "appboundry.json"),
    JSON.stringify({ application: { id: "org-eve", name: "Organization eve", version: "1.0.0" } }),
  );
  writeFileSync(join(app, "tools", `${tool}.ts`), TOOLS[tool]);
  try {
    const { report } = await produce({
      appRoot: app,
      engine: ENGINE,
      out: join(scratch(), `${tool}.app`),
    });
    return { built: true, tool: report.agent.tools.find((t) => t.tool === tool) };
  } catch (error) {
    return {
      built: false,
      code: error.code,
      message: error.message,
      tool: error.report?.agent.tools.find((t) => t.tool === tool),
    };
  }
}

describe(
  "eve's built-in tools on AppBoundry: what the producer builds and refuses",
  { skip: needsEngine, timeout: 900_000 },
  () => {
    const results = {};
    before(async () => {
      for (const tool of Object.keys(TOOLS)) results[tool] = await buildWith(tool);
    });
    after(() => {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    });

    const SANDBOX = /it works in the agent's sandbox, and AppBoundry provides none/;
    const refusals = {
      bash: [/node:crypto/, SANDBOX],
      read_file: [/node:crypto, node:path/, SANDBOX],
      write_file: [/node:crypto, node:path/, SANDBOX],
      edit_file: [/node:crypto, node:path/, SANDBOX],
      glob: [/node:crypto, node:path/, SANDBOX],
      grep: [SANDBOX],
      web_fetch: [/node:dns/, /AppBoundry gives an artifact no network/],
      web_search: [/provider tool .* model@1 does not run provider tools/],
      agent: [/child session task, which this host does not keep durably/],
      sleep: [/node:async_hooks, node:crypto, node:url, node:util/],
    };
    for (const [tool, reasons] of Object.entries(refusals)) {
      it(`refuses ${tool}, saying what it needs that AppBoundry does not provide`, () => {
        assert.equal(results[tool].built, false, JSON.stringify(results[tool]));
        assert.equal(results[tool].code, "TOOL_UNAVAILABLE");
        const line = results[tool].message.split("\n").find((l) => l.startsWith(`  ${tool} `));
        for (const reason of reasons) assert.match(line, reason);
      });
    }

    it("builds ask_question and no_reply, the eve tools verified on AppBoundry's production host", () => {
      for (const tool of ["ask_question", "no_reply"]) {
        assert.equal(results[tool].built, true, JSON.stringify(results[tool]));
        assert.ok(results[tool].tool.eveTools.length > 0);
      }
    });
  },
);

describe(
  "eve's framework tools that build, running on AppBoundry's production host",
  { skip: needsAppBoundry, timeout: 900_000 },
  () => {
    let host;
    before(async () => {
      const model = scriptedModel();
      const repo = await provider();
      host = hostProcess({
        artifact: (await artifactOf("framework-tools-agent")).path,
        state: join(scratch("eve-state-"), "state"),
        ...bindings({ modelUrl: await listen(model.server), providerUrl: repo.url }),
      });
      await host.ready;
    });
    after(async () => {
      await host?.close();
      await closeServers();
      cleanup();
    });

    it("ask_question waits for the person's answer, and the turn continues with it", async () => {
      const asked = await host.call(
        "eve:deliver",
        deliverArgs("rooms", "Alice: please ask me which room."),
      );
      assert.equal(asked.ok, true, JSON.stringify(asked.error));
      assert.equal(asked.value.status, "awaiting-input");
      const [interaction] = asked.value.interactions;
      assert.equal(interaction.call.name, "ask_question");
      assert.equal(interaction.request.kind, "question");
      assert.deepEqual(
        interaction.request.options.map((o) => o.id),
        ["North", "South"],
      );
      const answered = await host.call("eve:answer", {
        session: "meetings.rooms",
        application: "meetings",
        conversation: "rooms",
        answers: [{ interactionId: interaction.interactionId, optionId: "North" }],
      });
      assert.equal(answered.ok, true, JSON.stringify(answered.error));
      assert.equal(answered.value.status, "completed");
      assert.match(answered.value.reply, /North/);
    });

    it("no_reply ends the turn without a reply", async () => {
      const quiet = await host.call("eve:deliver", deliverArgs("quiet", "Bob: please stay quiet."));
      assert.equal(quiet.ok, true, JSON.stringify(quiet.error));
      assert.equal(quiet.value.status, "completed");
      assert.equal(quiet.value.reply, null);
    });
  },
);

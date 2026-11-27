import { execFile } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPBOUNDRY_CLI,
  artifactOf,
  cleanup,
  hostModule,
  needsAppBoundry,
  scratch,
} from "./support.mjs";

after(cleanup);
const run = promisify(execFile);
const appboundry = (...args) =>
  run(process.execPath, [APPBOUNDRY_CLI, ...args], { maxBuffer: 1 << 24 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
const altered = async (name, edit) => {
  const { path } = await artifactOf(name);
  const copy = join(scratch(), `${name}-altered.app`);
  cpSync(path, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
  edit(manifest);
  writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest, null, 2));
  return copy;
};

describe(
  "AppBoundry and the produced artifact",
  { skip: needsAppBoundry, timeout: 600_000 },
  () => {
    it("parses the manifest under AppBoundry's own schema", async () => {
      const { parseManifest } = await hostModule();
      for (const name of ["minimal-agent", "framework-tools-agent"]) {
        const { manifest } = await artifactOf(name);
        const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
        assert.equal(parsed.application.id, "org-eve");
        assert.deepEqual(
          parsed.functions.map((f) => ({ ...f.agent })),
          [
            { session: "session", actor: "assertion" },
            { session: "session", actor: "assertion" },
          ],
        );
      }
    });

    for (const name of ["minimal-agent", "framework-tools-agent"]) {
      it(`verifies ${name}: hashes, program section, and the program loads in the guest describing the manifest's functions`, async () => {
        const { path } = await artifactOf(name);
        const result = await appboundry("artifact", "verify", path);
        assert.equal(result.code, 0, result.stderr);
        assert.match(
          result.stdout,
          /manifest, module\.wasm \(sha256:[0-9a-f]+…\), program section and 0 frontend files verified/,
        );
        assert.match(
          result.stdout,
          /program loaded in the guest: 2 functions match the manifest \(eve-appboundry\/[\d.]+\)/,
        );
      });
    }

    it("inspects it: application, producer, interfaces, roles, and no host access", async () => {
      const { path } = await artifactOf("minimal-agent");
      const result = await appboundry("artifact", "inspect", path);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Application\s+org-eve 1\.0\.0/);
      assert.match(
        result.stdout,
        /Producer\s+eve-appboundry [\d.]+\s+format appboundry\.app\/1, guest ABI appboundry-guest\/1/,
      );
      assert.match(
        result.stdout,
        /Interfaces\s+actions@1, agents@1, connections@1, identity@1, model@1, sessions@1, capabilities@1/,
      );
      assert.match(
        result.stdout,
        /Host access\s+read none; write none; services none; network none; filesystem none/,
      );
    });

    it("refuses an interface version the host does not serve", async () => {
      const copy = await altered("minimal-agent", (m) => (m.runtime.interfaces.agents = 2));
      const result = await appboundry("artifact", "verify", copy);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /ARTIFACT_INTERFACE_UNSUPPORTED.*agents@2/);
    });

    it("refuses agent deliveries without agents@1, and actions without actions@1", async () => {
      const noAgents = await appboundry(
        "artifact",
        "verify",
        await altered("minimal-agent", (m) => {
          delete m.runtime.interfaces.agents;
          delete m.runtime.interfaces.connections;
          for (const fn of m.functions) delete fn.agent.actor;
        }),
      );
      assert.notEqual(noAgents.code, 0);
      assert.match(
        noAgents.stderr,
        /eve:deliver is an agent delivery, which needs the agents@1 host interface/,
      );
      const noActions = await appboundry(
        "artifact",
        "verify",
        await altered("minimal-agent", (m) => delete m.runtime.interfaces.actions),
      );
      assert.notEqual(noActions.code, 0);
      assert.match(
        noActions.stderr,
        /eve:deliver is an action, which needs the actions@1 host interface/,
      );
    });

    it("refuses a manifest whose functions differ from what the program describes", async () => {
      const copy = await altered("minimal-agent", (m) => m.functions.pop());
      const result = await appboundry("artifact", "verify", copy);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /different functions than its manifest/);
    });
  },
);

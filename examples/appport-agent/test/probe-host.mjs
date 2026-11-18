import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { defineCapability, s } from "@appport/sdk";

import { AGENT_ID, startInventoryHost } from "../appport-host/host.mjs";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

const effectsFile = required("PROBE_EFFECTS_FILE");
const applied = (entry) =>
  existsSync(effectsFile)
    ? readFileSync(effectsFile, "utf8")
        .split("\n")
        .filter((line) => line === entry).length
    : 0;

const probe = (name, idempotency) =>
  defineCapability({
    authorization: ["probe.write"],
    description: "Test-only side effect, appended to a file outside this process.",
    effect: "consequential",
    handler({ token }) {
      appendFileSync(effectsFile, `${name}:${token}\n`);
      return { applied: applied(`${name}:${token}`), token };
    },
    idempotency,
    input: s.object({ token: s.string() }),
    name,
    output: s.object({ applied: s.integer(), token: s.string() }),
    version: 1,
  });

const host = await startInventoryHost({
  adminSecret: required("AUTHBOUNDRY_ADMIN_SECRET"),
  agentCredentialFile: required("APPPORT_AGENT_CREDENTIAL_FILE"),
  dataDir: required("APPPORT_HOST_DATA_DIR"),
  extraCapabilities: [
    probe("probe.applykeyed", "supported"),
    probe("probe.applyunkeyed", "unsupported"),
  ],
  extraPermissions: ["probe.write"],
  idempotencyFault: async (point, entry) => {
    if (entry.key.includes(`[crash:${point}]`)) process.kill(process.pid, "SIGKILL");
  },
  port: Number(required("APPPORT_PORT")),
  provenanceFile: required("APPPORT_PROVENANCE_FILE"),
});
for (const delegator of (process.env.PROBE_GRANTS ?? "").split(",").filter(Boolean)) {
  await host.authority.grant({
    agent: AGENT_ID,
    capabilities: ["catalog.read", "probe.write"],
    delegator,
  });
}
writeFileSync(required("PROBE_AUTHORITY_PID_FILE"), String(host.authority.process.pid));
console.log(`[probe-host] owner ${host.idempotency.owner} listening at ${host.url}`);

import { createHash } from "node:crypto";
import { PROGRAM_SECTION } from "./wasm.mjs";

export const ARTIFACT_FORMAT = "appboundry.app/1";
export const GUEST_ABI = "appboundry-guest/1";
export const DELIVER_PERMISSION = "eve.deliver";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const delivery = (extra, required) => ({
  type: "object",
  additionalProperties: false,
  required: ["session", "conversation", ...required],
  properties: {
    session: {
      type: "string",
      description:
        "<application>.<conversation>: the session this delivery belongs to (agents@1 serializes per session; connections@1 keeps it to the calling application's own)",
    },
    conversation: {
      type: "string",
      description: "The conversation within the calling application",
    },
    assertion: {
      type: "string",
      description:
        "The calling application's signed assertion of the person asking (ES256 JWT); the host verifies and removes it",
    },
    ...extra,
  },
});

export const FUNCTIONS = [
  {
    name: "eve:deliver",
    kind: "action",
    access: DELIVER_PERMISSION,
    description:
      "Delivers a message to the agent in one application's conversation and returns the turn's result.",
    args: delivery({ message: { type: "string" } }, ["message"]),
    timeoutMs: 600_000,
    agent: { session: "session", actor: "assertion" },
  },
  {
    name: "eve:answer",
    kind: "action",
    access: DELIVER_PERMISSION,
    description:
      "Answers the agent's pending approvals or questions in one application's conversation.",
    args: delivery({ answers: { type: "array", items: { type: "object" } } }, ["answers"]),
    timeoutMs: 600_000,
    agent: { session: "session", actor: "assertion" },
  },
];

export const interfacesFor = (requires) => ({
  actions: 1,
  agents: 1,
  connections: 1,
  identity: 1,
  model: 1,
  sessions: 1,
  ...(requires.length ? { capabilities: 1 } : {}),
});

export function artifactManifest({ application, producer, module, program, requires, omitted }) {
  return {
    format: ARTIFACT_FORMAT,
    runtime: { abi: GUEST_ABI, interfaces: interfacesFor(requires) },
    producer,
    application,
    module: {
      path: "module.wasm",
      sha256: sha256(module),
      size: module.byteLength,
      imports: [],
      program: { section: PROGRAM_SECTION, sha256: sha256(program), size: program.byteLength },
    },
    functions: FUNCTIONS,
    collections: [],
    ...(requires.length ? { requires } : {}),
    identity: { roles: { member: [DELIVER_PERMISSION] }, devUsers: [], sessionTtlMs: 3_600_000 },
    services: {},
    permissions: {
      collections: { read: [], write: [] },
      services: [],
      network: "none",
      filesystem: "none",
    },
    appport: {
      protocol: "appport/1",
      application: { id: application.id, name: application.name, version: application.version },
      capabilities: [],
    },
    frontend: null,
    omitted,
  };
}

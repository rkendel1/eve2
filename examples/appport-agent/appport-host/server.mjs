import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import {
  createApplication,
  createServer,
  defineCapability,
  permissionAuthorizer,
  s,
} from "@appport/sdk";
import { serve } from "@appport/sdk/node";

const here = (file) => new URL(file, import.meta.url);
const secret = process.env.APPPORT_AGENT_ASSERTION_SECRET ?? "";
if (secret.length < 32)
  throw new Error("APPPORT_AGENT_ASSERTION_SECRET must be at least 32 characters.");
const provenanceFile = process.env.APPPORT_PROVENANCE_FILE ?? "appport-provenance.jsonl";
const principals = JSON.parse(readFileSync(here("./principals.json"), "utf8"));

const catalogLookup = defineCapability({
  name: "catalog.lookup",
  version: 1,
  description: "Reads one catalog item by SKU. Read-only.",
  effect: "observation",
  authorization: ["catalog.read"],
  input: s.object({ sku: s.string() }),
  output: s.object({ sku: s.string(), name: s.string(), quantity: s.integer() }),
  handler({ sku }) {
    const { items } = JSON.parse(readFileSync(here("./catalog.json"), "utf8"));
    const item = items.find((entry) => entry.sku === sku);
    if (item === undefined) throw new Error(`No catalog item has SKU ${sku}.`);
    return item;
  },
});

const application = createApplication({
  application: { id: "inventory", name: "Inventory", version: "1.0.0" },
  capabilities: [catalogLookup],
  authorizer: permissionAuthorizer({
    resolvePermissions: ({ principal }) => (principal ? (principals[principal.id] ?? []) : []),
  }),
  telemetry: {
    record(entry) {
      appendFileSync(
        provenanceFile,
        `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
      );
    },
  },
  mode: "production",
});

function verifyAgentAssertion(authorization) {
  const token = /^Bearer (.+)$/u.exec(authorization ?? "")?.[1];
  if (token === undefined) return undefined;
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "appport-agent" || claims.aud !== "appport:inventory") return undefined;
  if (typeof claims.exp !== "number" || claims.exp < now || typeof claims.sub !== "string")
    return undefined;
  return claims;
}

const server = createServer({
  application,
  authenticate({ headers }) {
    const claims = verifyAgentAssertion(headers?.authorization);
    if (claims === undefined) return {};
    const principal = { id: claims.sub, type: "user", attributes: { actingAgent: claims.act } };
    const session = {
      id: `agent_${claims.jti}`,
      applicationId: "inventory",
      createdAt: new Date(claims.iat * 1000).toISOString(),
      principal,
    };
    return { session, principal };
  },
});

const running = await serve({
  server,
  host: process.env.APPPORT_HOST ?? "127.0.0.1",
  port: Number(process.env.APPPORT_PORT ?? 4317),
  websocket: false,
});
console.log(`[appport] inventory listening at ${running.url}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void running.close().then(() => process.exit(0)));
}

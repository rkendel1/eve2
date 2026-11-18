import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startLocalAuthority } from "@authboundry/local";
import { AppPortError, createApplication, createServer, defineCapability, s } from "@appport/sdk";
import { serve } from "@appport/sdk/node";

export const APPLICATION_ID = "inventory";
export const AGENT_ID = "agent:appport-agent";
const CAPABILITIES = ["catalog.read"];
const here = (file) => new URL(file, import.meta.url);

function readSecret(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

function writeSecret(file, value) {
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

function sameSecret(presented, held) {
  if (typeof presented !== "string" || typeof held !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(held);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startInventoryHost({
  adminSecret,
  agentCredentialFile,
  authorityLogger,
  dataDir,
  host = "127.0.0.1",
  port = 4317,
  provenanceFile,
}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const checkCredentialFile = join(dataDir, "check-credential");
  const record = (entry) =>
    appendFileSync(
      provenanceFile,
      `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
    );

  const authority = await startLocalAuthority({
    adminSecret,
    agents: [
      {
        capabilities: CAPABILITIES,
        credential: readSecret(agentCredentialFile),
        id: AGENT_ID,
        name: "eve AppPort agent",
        onCredential: (secret) => writeSecret(agentCredentialFile, secret),
      },
    ],
    application: { capabilities: CAPABILITIES, id: APPLICATION_ID, name: "Inventory" },
    checkCredential: readSecret(checkCredentialFile),
    dataDir: join(dataDir, "authority"),
    executor: { id: `agent:${APPLICATION_ID}`, name: "Inventory" },
    ...(authorityLogger ? { logger: authorityLogger } : {}),
  });
  if (authority.issuedCheckCredential) writeSecret(checkCredentialFile, authority.checkCredential);
  if (authority.registeredAgents[0].issuedAgentCredential)
    writeSecret(agentCredentialFile, authority.registeredAgents[0].agentCredential);

  const delegatedAuthority = {
    name: "authboundry",
    async authorize({ capability, principal, requestId, required, session }) {
      if (required.length === 0) return { allowed: true };
      const agent = principal?.attributes?.agent;
      if (principal === undefined || agent !== AGENT_ID)
        return { allowed: false, code: "UNAUTHORIZED", reason: "No proven agent." };
      const decisions = [];
      for (const permission of required) {
        const answer = await authority.check(permission, principal.id, { agent }).catch((error) => {
          record({
            capability: capability.name,
            error: error.message,
            kind: "authorization",
            onBehalfOf: principal.id,
            agent,
            requestId,
            decision: "unavailable",
          });
          throw new AppPortError("INTERNAL_ERROR", "The delegation authority is unavailable.");
        });
        const body = answer.body ?? {};
        record({
          agent: body.executor?.principal_id ?? agent,
          capability: capability.name,
          decision: body.decision ?? `http_${answer.status}`,
          decisionId: body.decision_id ?? null,
          delegationId: body.delegation_id ?? null,
          kind: "authorization",
          onBehalfOf: principal.id,
          permission,
          reason: body.reason ?? null,
          requestId,
        });
        if (answer.status !== 200 || body.decision !== "allow")
          return {
            allowed: false,
            code: "FORBIDDEN",
            reason: body.reason ?? `authority answered ${answer.status}`,
          };
        decisions.push(body);
      }
      return {
        allowed: true,
        decision: {
          authorizer: "authboundry",
          capability,
          decisionId: decisions[0].decision_id,
          evidenceId: decisions[0].delegation_id,
          principalId: principal.id,
          sessionId: session?.id,
        },
      };
    },
  };

  const catalogLookup = defineCapability({
    name: "catalog.lookup",
    version: 1,
    description: "Reads one catalog item by SKU. Read-only.",
    effect: "observation",
    authorization: ["catalog.read"],
    input: s.object({ sku: s.string() }),
    output: s.object({ sku: s.string(), name: s.string(), quantity: s.integer() }),
    handler({ sku }, ctx) {
      record({
        capability: "catalog.lookup",
        delegationId: ctx.authorizationDecision?.evidenceId ?? null,
        kind: "execution",
        onBehalfOf: ctx.principal?.id ?? null,
        requestId: ctx.requestId,
      });
      const { items } = JSON.parse(readFileSync(here("./catalog.json"), "utf8"));
      const item = items.find((entry) => entry.sku === sku);
      if (item === undefined) throw new Error(`No catalog item has SKU ${sku}.`);
      return item;
    },
  });

  const application = createApplication({
    application: { id: APPLICATION_ID, name: "Inventory", version: "1.0.0" },
    authorizer: delegatedAuthority,
    capabilities: [catalogLookup],
    mode: "production",
    telemetry: { record: (entry) => record({ ...entry, kind: "request" }) },
  });

  const server = createServer({
    application,
    authenticate({ headers }) {
      const presented = /^Bearer (.+)$/u.exec(headers?.authorization ?? "")?.[1];
      const onBehalfOf = headers?.["x-appport-on-behalf-of"];
      if (!sameSecret(presented, authority.agentCredentialOf(AGENT_ID))) return {};
      if (typeof onBehalfOf !== "string" || onBehalfOf.length === 0) return {};
      const principal = { attributes: { agent: AGENT_ID }, id: onBehalfOf, type: "user" };
      const session = {
        applicationId: APPLICATION_ID,
        createdAt: new Date().toISOString(),
        id: `agent_${randomUUID()}`,
        principal,
      };
      return { principal, session };
    },
  });

  const running = await serve({ host, port, server, websocket: false });
  return {
    authority,
    async close() {
      await running.close();
      await authority.close();
    },
    url: running.url,
  };
}

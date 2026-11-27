import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHECKOUT, hostDependency } from "../support.mjs";

export const TOKEN = "provider-issued-consumer-token";
export const appPrincipal = (application) => ({
  id: `app.${application}`,
  type: "service",
  roles: ["member"],
});
export const servers = [];

export const listen = async (server) => {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
export const closeServers = async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const text = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");

export function gate() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
}

export function scriptedModel() {
  const requests = [];
  const gates = new Map();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const messages = request.messages;
    const last = messages.at(-1);
    const users = messages.filter((m) => m.role === "user").map((m) => text(m.content));
    const asked = users.at(-1) ?? "";
    for (const [word, waiting] of gates)
      if (last.role !== "tool" && asked.includes(word)) await waiting.opened;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const call = (name, args) =>
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      });
    let tool = false;
    if (last.role === "tool")
      send({ choices: [{ index: 0, delta: { content: `Result: ${text(last.content)}` } }] });
    else if (/change (\d+)/.test(asked)) {
      tool = true;
      call("repo_changes_get", {
        repository: "rkendel1/meetings",
        number: Number(/change (\d+)/.exec(asked)[1]),
      });
    } else if (/please ask/i.test(asked)) {
      tool = true;
      call("ask_question", {
        question: "Which room?",
        options: [
          { label: "North", description: "The north room" },
          { label: "South", description: "The south room" },
        ],
      });
    } else if (/stay quiet/i.test(asked)) {
      tool = true;
      call("no_reply", { reason: "Nothing to add." });
    } else if (/publish/i.test(asked)) {
      tool = true;
      call("repo_changes_publish", { repository: "rkendel1/meetings", title: "Weekly notes" });
    } else send({ choices: [{ index: 0, delta: { content: `Heard: ${users.join(" | ")}` } }] });
    send({
      choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    res.end("data: [DONE]\n\n");
  });
  return { server, requests, gates };
}

export async function provider({ hang = new Set() } = {}) {
  const [
    { createApplication, defineCapability },
    { s },
    { createHttpBinding, createServer: createAppPortServer },
    { createNodeRequestListener },
  ] = await Promise.all(
    ["@appport/core", "@appport/schema", "@appport/server", "@appport/server/node"].map(
      hostDependency,
    ),
  );
  const received = [];
  const application = createApplication({
    application: { id: "repo", name: "Repository", version: "1.0.0" },
    capabilities: [
      defineCapability({
        name: "repo.changes.get",
        version: 1,
        input: s.object({ repository: s.string(), number: s.number() }),
        output: s.object({ number: s.number(), merged: s.boolean() }),
        authorization: [],
        idempotency: "supported",
        handler: async (input, context) => {
          received.push({
            capability: "repo.changes.get",
            key: context.idempotencyKey,
            input,
            claimed: context.invocation?.claimed,
          });
          if (hang.has(input.number)) await new Promise(() => {});
          return { number: input.number, merged: true };
        },
      }),
      defineCapability({
        name: "repo.changes.publish",
        version: 1,
        input: s.object({ repository: s.string(), title: s.string() }),
        output: s.object({ ok: s.boolean() }),
        authorization: [],
        idempotency: "supported",
        handler: async (input, context) => (
          received.push({
            capability: "repo.changes.publish",
            key: context.idempotencyKey,
            input,
            claimed: context.invocation?.claimed,
          }),
          { ok: true }
        ),
      }),
    ],
  });
  const appport = createAppPortServer({
    application,
    authenticate: (request) =>
      request.headers?.authorization === `Bearer ${TOKEN}`
        ? { principal: { id: "org-eve", type: "application" } }
        : {},
  });
  const listener = createNodeRequestListener(createHttpBinding({ server: appport }));
  const url = await listen(
    createServer((req, res) =>
      req.headers.authorization !== `Bearer ${TOKEN}`
        ? res.writeHead(401).end()
        : listener(req, res),
    ),
  );
  return { url: `${url}/appport`, received };
}

export const bindings = ({ modelUrl, providerUrl, capabilityTimeoutMs = 1_000 }) => ({
  modelBinding: {
    provider: "scripted",
    protocol: "openai-compatible",
    model: "org-model",
    endpoint: `${modelUrl}/v1`,
    allowedHosts: ["127.0.0.1"],
  },
  capabilityBindings: ["repo.changes.get", "repo.changes.publish"].map((capability, i) => ({
    capability,
    version: 1,
    provider: { applicationId: "repo", url: providerUrl },
    credential: TOKEN,
    grant: { id: `g-${i}` },
    timeoutMs: capabilityTimeoutMs,
  })),
});

export const inProcessOperator = (host) => {
  const actor = { kind: "local", name: "test" };
  return (action, input = {}) =>
    action === "user"
      ? host.admin((a) => a.addUser(actor, input))
      : action === "connect"
        ? host.connectApplication(actor, input)
        : action === "list"
          ? host.listConnections()
          : host.changeConnection(actor, action, input.application);
};

export const deliverArgs = (
  conversation,
  message,
  { application = "meetings", assertion } = {},
) => ({
  session: `${application}.${conversation}`,
  conversation,
  message,
  ...(assertion ? { assertion } : {}),
});
export const answerArgs = (
  conversation,
  answers,
  { application = "meetings", assertion } = {},
) => ({
  session: `${application}.${conversation}`,
  conversation,
  answers,
  ...(assertion ? { assertion } : {}),
});

export async function organization(applications) {
  const { startLocalAuthority } = await import("@authboundry/local");
  const capabilities = [...new Set(Object.values(applications).flat())];
  const authority = await startLocalAuthority({
    dataDir: mkdtempSync(join(tmpdir(), "eve-authority-")),
    application: { id: "org-eve", name: "Organization eve", capabilities },
    executor: { id: "agent:org-eve", name: "Organization eve" },
    adminSecret: randomBytes(24).toString("hex"),
  });
  const keys = Object.fromEntries(
    Object.keys(applications).map((application) => [
      application,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    ]),
  );
  return {
    authority,
    binding: {
      url: authority.url,
      applicationId: "org-eve",
      agent: "agent:org-eve",
      checkCredential: authority.checkCredential,
      agentCredential: authority.agentCredential,
    },
    assertion(application, person, claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const head = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: `feltkit:${application}`, aud: "org-eve", sub: person, kind: "person", iat: now, exp: now + 120, jti: randomUUID(), ...claims })}`;
      return `${head}.${sign("sha256", Buffer.from(head), { key: keys[application].privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    },
    async connect(operator, application) {
      await operator("user", { id: `app.${application}`, roles: ["member"], type: "service" });
      return operator("connect", {
        application,
        principal: `app.${application}`,
        capabilities: applications[application],
        assertion: {
          issuer: `feltkit:${application}`,
          publicKeys: [
            keys[application].publicKey.export({ type: "spki", format: "pem" }).toString(),
          ],
        },
      });
    },
    async grant(person, granted) {
      await authority.ensurePrincipal(person);
      return authority.grant({ delegator: person, capabilities: granted });
    },
    revoke: (id) => authority.revoke(id),
    close: () => authority.close(),
  };
}

export function hostProcess({ artifact, state, agentIdleMs = 60_000, ...rest }) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./host-process.mjs", import.meta.url)),
      JSON.stringify({ checkout: CHECKOUT, artifact, state, agentIdleMs, ...rest }),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const waiting = new Map();
  const messages = [];
  let opened;
  const ready = new Promise((resolve) => (opened = resolve));
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      messages.push(message);
      if (message.opened) opened(message);
      if (message.id !== undefined) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  let next = 0;
  const send = (command) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  return {
    ready,
    exited,
    messages,
    call: async (fn, args, principal = appPrincipal(args.session?.split(".")[0] ?? "meetings")) =>
      (await send({ op: "call", fn, args, principal })).result,
    operator: async (action, input = {}) => {
      const answer = await send({ op: "operator", action, input });
      if (answer.error)
        throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.value;
    },
    outbound: async () => (await send({ op: "outbound" })).value,
    status: async () => (await send({ op: "status" })).status,
    close: async () => (await send({ op: "close" }), exited),
    kill: () => (child.kill("SIGKILL"), exited),
  };
}

export async function sessionState(state) {
  const { openState, AGENT_SESSIONS_COLLECTION, AGENT_SESSION_LINES_COLLECTION } = await import(
    pathToFileURL(join(CHECKOUT, "packages/appboundry-host/dist/index.js")).href
  );
  const opened = openState(state, "org-eve");
  const all = async (collection) => (await opened.db.query({ collection, limit: 1000 })).records;
  const sessions = await all(AGENT_SESSIONS_COLLECTION);
  const lines = await all(AGENT_SESSION_LINES_COLLECTION);
  return {
    sessions: Object.fromEntries(sessions.map((doc) => [doc.sessionId, doc])),
    lineCount: (sessionId) => lines.filter((line) => line.sessionId === sessionId).length,
    byLane: (lane) => sessions.filter((doc) => doc.lane === lane),
    write: (doc, value) =>
      opened.db.transaction({
        operations: [
          { collection: AGENT_SESSIONS_COLLECTION, id: doc.id, ifVersion: doc.__version, value },
        ],
      }),
    close: () => opened.db.close(),
  };
}

export const until = async (check, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50)))
    if (await check()) return;
  throw new Error("condition not met in time");
};

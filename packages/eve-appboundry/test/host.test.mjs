import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  artifactOf,
  cleanup,
  hostDependency,
  hostModule,
  needsAppBoundry,
  scratch,
} from "./support.mjs";

const TOKEN = "provider-issued-consumer-token";
const alice = { id: "alice", type: "user", roles: ["member"] };
const keepalive = setInterval(() => {}, 1 << 30);
const servers = [];
after(async () => {
  clearInterval(keepalive);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  cleanup();
});
const listen = async (server) => {
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
};

const text = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
function scriptedModel() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
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
    const messages = request.messages;
    const last = messages.at(-1);
    const users = messages.filter((m) => m.role === "user").map((m) => text(m.content));
    if (last.role === "tool")
      send({ choices: [{ index: 0, delta: { content: `Result: ${text(last.content)}` } }] });
    else if (/change (\d+)/.test(users.at(-1)))
      call("repo_changes_get", {
        repository: "rkendel1/meetings",
        number: Number(/change (\d+)/.exec(users.at(-1))[1]),
      });
    else if (/publish/i.test(users.at(-1)))
      call("repo_changes_publish", { repository: "rkendel1/meetings", title: "Weekly notes" });
    else send({ choices: [{ index: 0, delta: { content: `Heard: ${users.join(" | ")}` } }] });
    send({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            last.role === "tool" || !/change \d+|publish/i.test(users.at(-1))
              ? "stop"
              : "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    res.end("data: [DONE]\n\n");
  });
  return { server, requests };
}

async function provider() {
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
          received.push({ capability: "repo.changes.get", key: context.idempotencyKey, input });
          if (input.number === 13) await new Promise((r) => setTimeout(r, 5_000));
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
          received.push({ capability: "repo.changes.publish", key: context.idempotencyKey, input }),
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

describe(
  "the produced artifact on AppBoundry's production host",
  { skip: needsAppBoundry, timeout: 900_000 },
  () => {
    let ArtifactHost;
    let artifact;
    let model;
    let repo;
    let modelUrl;
    let state;
    let host;
    const open = async () =>
      ArtifactHost.open({
        artifact,
        stateDir: state,
        jobIntervalMs: 0,
        agentIdleMs: 60_000,
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
          provider: { applicationId: "repo", url: repo.url },
          credential: TOKEN,
          grant: { id: `g-${i}` },
          timeoutMs: 1_000,
        })),
      });
    const call = async (fn, args, principal = alice) =>
      host.call(fn, args, { principal, via: "eve-appboundry test" });
    const deliver = async (conversation, message) => {
      const result = await call("eve:deliver", {
        session: `meetings.${conversation}`,
        application: "meetings",
        conversation,
        message,
      });
      assert.ok(result.ok, JSON.stringify(result.error));
      return result.value;
    };

    before(async () => {
      const host = await hostModule();
      ArtifactHost = host.ArtifactHost;
      artifact = await host.loadArtifact((await artifactOf("minimal-agent")).path);
      model = scriptedModel();
      modelUrl = await listen(model.server);
      repo = await provider();
      state = join(scratch(), "state");
    });
    after(async () => host?.close());

    it("answers a delivery with the host's bound model and keeps the conversation in its session", async () => {
      host = await open();
      const one = await deliver("weekly-sync", "Alice says hello.");
      assert.equal(one.status, "completed");
      assert.equal(one.reply, "Heard: Alice says hello.");
      assert.deepEqual(one.modelReferences, ["anthropic/claude-sonnet-5"]);
      const two = await deliver("weekly-sync", "Alice asks what was said.");
      assert.equal(two.reply, "Heard: Alice says hello. | Alice asks what was said.");
      assert.equal(two.sessionId, one.sessionId);
      const other = await deliver("planning", "Bob starts planning.");
      assert.equal(other.reply, "Heard: Bob starts planning.");
      assert.notEqual(other.sessionId, one.sessionId);
      assert.ok(
        model.requests.every((r) => r.model === "org-model"),
        "the host's binding chose the model",
      );
    });

    it("calls a capability through capability.invoke, keyed by the tool call", async () => {
      const before = repo.received.length;
      const answer = await deliver("weekly-sync", "Alice asks about change 7.");
      assert.equal(answer.status, "completed");
      assert.match(answer.reply, /^Result: .*"merged":true/);
      const [received] = repo.received.slice(before);
      assert.equal(received.capability, "repo.changes.get");
      assert.match(received.key, new RegExp(`^${answer.sessionId}:`));
    });

    it("runs an approved call only once a person answers", async () => {
      const before = repo.received.length;
      const asked = await deliver("release", "Bob asks to publish the notes.");
      assert.equal(asked.status, "awaiting-input");
      assert.equal(asked.interactions.length, 1);
      assert.equal(repo.received.length, before, "nothing runs before a person answers");
      const answered = await call("eve:answer", {
        session: "meetings.release",
        application: "meetings",
        conversation: "release",
        answers: [{ interactionId: asked.interactions[0].interactionId, optionId: "approve" }],
      });
      assert.ok(answered.ok, JSON.stringify(answered.error));
      assert.equal(answered.value.status, "completed");
      assert.deepEqual(
        repo.received.slice(before).map((r) => r.capability),
        ["repo.changes.publish"],
      );
    });

    it("tells the model when a call may or may not have taken effect", async () => {
      const answer = await deliver("incident", "Carol asks about change 13.");
      assert.equal(answer.status, "completed");
      assert.match(answer.reply, /may or may not have taken effect/);
    });

    it("restores the session on a new host over the same state", async () => {
      await host.close();
      host = await open();
      const again = await deliver("weekly-sync", "Alice is back.");
      assert.equal(again.reply.split(" | ").at(-1), "Alice is back.");
      assert.ok(
        again.reply.startsWith("Heard: Alice says hello. | Alice asks what was said."),
        again.reply,
      );
    });

    it("refuses a delivery whose session is not its application's conversation, and a caller without permission", async () => {
      const mismatched = await call("eve:deliver", {
        session: "meetings.other",
        application: "meetings",
        conversation: "weekly-sync",
        message: "x",
      });
      assert.equal(mismatched.ok, false);
      assert.equal(mismatched.error.code, "INVALID_ARGUMENT");
      const stranger = await call(
        "eve:deliver",
        {
          session: "meetings.weekly-sync",
          application: "meetings",
          conversation: "weekly-sync",
          message: "x",
        },
        { id: "mallory", type: "user", roles: [] },
      );
      assert.equal(stranger.ok, false);
      assert.equal(stranger.error.code, "FORBIDDEN");
    });
  },
);

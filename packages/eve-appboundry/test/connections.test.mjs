import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { artifactOf, cleanup, needsAppBoundry, scratch } from "./support.mjs";
import {
  answerArgs,
  bindings,
  closeServers,
  deliverArgs,
  hostProcess,
  listen,
  organization,
  provider,
  scriptedModel,
  until,
} from "./support/production.mjs";

const UNCERTAIN = "may or may not have taken effect";
const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
};
const refusedCodes = (reply) => [...String(reply).matchAll(/"code":"([A-Z_]+)"/g)].map((m) => m[1]);

describe(
  "two applications connected to one organizational eve on AppBoundry",
  { skip: needsAppBoundry, timeout: 1_800_000 },
  () => {
    let org;
    let model;
    let repo;
    let config;
    let host;
    const say = (application, person, conversation, message) =>
      host.call(
        "eve:deliver",
        deliverArgs(conversation, message, {
          application,
          assertion: org.assertion(application, person),
        }),
      );

    before(async () => {
      org = await organization({
        meetings: ["repo.changes.get"],
        review: ["repo.changes.publish"],
      });
      await org.grant("user:alice", ["repo.changes.get"]);
      await org.grant("user:bob", ["repo.changes.publish"]);
      model = scriptedModel();
      repo = await provider({ hang: new Set([13]) });
      config = {
        artifact: (await artifactOf("minimal-agent")).path,
        state: join(scratch("eve-connections-"), "state"),
        ...bindings({ modelUrl: await listen(model.server), providerUrl: repo.url }),
        authority: org.binding,
        agentIdleMs: 2_000,
      };
      host = hostProcess(config);
      await host.ready;
    });
    after(async () => {
      await host?.close();
      await org?.close();
      await closeServers();
      cleanup();
    });

    let alicesMeeting;
    it("1-4: connects two applications to the one agent, each with its own identity and its own people", async () => {
      await org.connect(host.operator, "meetings");
      await org.connect(host.operator, "review");
      const listed = await host.operator("list");
      assert.deepEqual(
        listed.map((c) => [c.application, c.principal, c.status, c.capabilities]),
        [
          ["meetings", "app.meetings", "active", ["repo.changes.get"]],
          ["review", "app.review", "active", ["repo.changes.publish"]],
        ],
      );
      alicesMeeting = ok(
        await say("meetings", "user:alice", "weekly", "Alice asks about change 7."),
      );
      assert.match(alicesMeeting.reply, /"merged":true/);
      const asked = ok(
        await say("review", "user:bob", "release", "Bob asks to publish the notes."),
      );
      assert.equal(asked.status, "awaiting-input");
      const answered = ok(
        await host.call(
          "eve:answer",
          answerArgs(
            "release",
            [{ interactionId: asked.interactions[0].interactionId, optionId: "approve" }],
            { application: "review", assertion: org.assertion("review", "user:bob") },
          ),
        ),
      );
      assert.equal(answered.status, "completed");
      const ledger = await host.outbound();
      assert.deepEqual(
        ledger
          .map((r) => [
            r.consumer.applicationId,
            r.connection,
            r.actor.id,
            r.capability.name,
            r.state,
          ])
          .sort(),
        [
          ["org-eve", "meetings", "user:alice", "repo.changes.get", "succeeded"],
          ["org-eve", "review", "user:bob", "repo.changes.publish", "succeeded"],
        ],
        "one agent (org-eve) acted for each application's own person",
      );
      assert.deepEqual(repo.received.map((r) => r.capability).sort(), [
        "repo.changes.get",
        "repo.changes.publish",
      ]);
    });

    it("5: an application cannot reach another's conversations, sign for its people, or name itself in arguments", async () => {
      const intoOther = await host.call(
        "eve:deliver",
        deliverArgs("weekly", "Bob peeks.", { assertion: org.assertion("review", "user:bob") }),
        { id: "app.review", type: "service", roles: ["member"] },
      );
      assert.equal(intoOther.ok, false);
      assert.equal(intoOther.error.details.reason, "SESSION_OUTSIDE_CONNECTION");
      const forged = await host.call(
        "eve:deliver",
        deliverArgs("weekly", "Bob as Alice.", {
          application: "meetings",
          assertion: org.assertion("review", "user:alice", { iss: "feltkit:meetings" }),
        }),
        { id: "app.meetings", type: "service", roles: ["member"] },
      );
      assert.equal(forged.ok, false);
      assert.equal(forged.error.code, "UNAUTHORIZED");
      const named = await host.call(
        "eve:deliver",
        { ...deliverArgs("weekly", "x"), application: "review" },
        { id: "app.meetings", type: "service", roles: ["member"] },
      );
      assert.equal(named.ok, false);
      assert.equal(named.error.code, "INVALID_ARGUMENT");
    });

    it("8: keeps each application's context in its own conversations", async () => {
      const requests = model.requests.length;
      const sameName = ok(await say("review", "user:bob", "weekly", "Bob opens a weekly thread."));
      assert.equal(sameName.reply, "Heard: Bob opens a weekly thread.");
      assert.notEqual(sameName.sessionId, alicesMeeting.sessionId);
      assert.ok(
        !JSON.stringify(model.requests.slice(requests)).includes("change 7"),
        "nothing of meetings' conversation reaches review's turn",
      );
    });

    it("9-11: acts only under authority AuthBoundry grants now, never another application's capability", async () => {
      const before = repo.received.length;
      const mallory = ok(
        await say("meetings", "user:mallory", "weekly", "Mallory asks about change 8."),
      );
      assert.deepEqual(refusedCodes(mallory.reply), ["DELEGATION_DENIED"]);
      assert.match(mallory.reply, /delegation_missing/);
      const crossing = ok(
        await say("meetings", "user:alice", "standup", "Alice asks to publish the notes."),
      );
      assert.equal(crossing.status, "awaiting-input");
      const crossed = ok(
        await host.call(
          "eve:answer",
          answerArgs(
            "standup",
            [{ interactionId: crossing.interactions[0].interactionId, optionId: "approve" }],
            { assertion: org.assertion("meetings", "user:alice") },
          ),
        ),
      );
      assert.deepEqual(
        refusedCodes(crossed.reply),
        ["CAPABILITY_NOT_CONNECTED"],
        "meetings does not contribute review's capability",
      );
      const [aliceGrant] = await org.authority.delegations("user:alice");
      await org.revoke(aliceGrant.id);
      const revoked = ok(
        await say("meetings", "user:alice", "weekly", "Alice asks about change 9."),
      );
      assert.deepEqual(refusedCodes(revoked.reply), ["DELEGATION_DENIED"]);
      assert.match(revoked.reply, /delegation_revoked/);
      assert.equal(repo.received.length, before, "no refused call reached the provider");
      await org.grant("user:alice", ["repo.changes.get"]);
    });

    it("12: records the connection, the person and AuthBoundry's decision for each call, and no assertion or credential", async () => {
      const ledger = await host.outbound();
      for (const record of ledger) {
        assert.ok(
          record.connection && record.actor?.id && record.actor.issuer.startsWith("feltkit:"),
        );
        for (const attempt of record.attempts)
          assert.match(attempt.authority.decisionId, /decision/);
      }
      const text = JSON.stringify(ledger);
      assert.ok(!text.includes("eyJ"), "no assertion");
      assert.ok(
        !text.includes(org.binding.agentCredential) && !text.includes(org.binding.checkCredential),
        "no AuthBoundry credential",
      );
      const claimed = repo.received.find((r) => r.capability === "repo.changes.get");
      assert.deepEqual(claimed.claimed?.actor, { id: "user:alice", type: "user" });
      assert.match(
        claimed.claimed.delegationId,
        /.+/,
        "the provider sees the delegation AuthBoundry decided under",
      );
    });

    it("6-7: disconnects one application without touching the other, and reconnects it to the same agent and conversation", async () => {
      await host.operator("disconnect", { application: "meetings" });
      const refused = await say("meetings", "user:alice", "weekly", "Alice is cut off.");
      assert.equal(refused.ok, false);
      assert.equal(refused.error.details.reason, "CONNECTION_DISCONNECTED");
      assert.equal(
        ok(await say("review", "user:bob", "weekly", "Bob carries on.")).reply,
        "Heard: Bob opens a weekly thread. | Bob carries on.",
      );
      await host.operator("reconnect", { application: "meetings" });
      const back = ok(await say("meetings", "user:alice", "weekly", "Alice is back."));
      assert.equal(
        back.sessionId,
        alicesMeeting.sessionId,
        "the same conversation, on the same agent",
      );
      const [record] = (await host.operator("list")).filter((c) => c.application === "meetings");
      assert.deepEqual(
        record.history.map((h) => h.change),
        ["connected", "disconnected", "reconnected"],
      );
    });

    it("13: keeps connection rules across idle release and restore", async () => {
      await until(async () => (await host.status()).agents.warm === 0);
      const released = (await host.status()).agents;
      const restored = ok(await say("meetings", "user:alice", "weekly", "Alice after the pause."));
      assert.equal(restored.start.restored, 1);
      assert.equal((await host.status()).agents.started, released.started + 1);
      const stillOutside = await host.call(
        "eve:deliver",
        deliverArgs("weekly", "x", { assertion: org.assertion("review", "user:bob") }),
        { id: "app.review", type: "service", roles: ["member"] },
      );
      assert.equal(stillOutside.error.details.reason, "SESSION_OUTSIDE_CONNECTION");
    });

    it("15: reports an uncertain capability outcome once and never resends it", async () => {
      const before = repo.received.filter((r) => r.input.number === 13).length;
      const uncertain = ok(
        await say("meetings", "user:alice", "incident", "Alice asks about change 13."),
      );
      assert.match(uncertain.reply, new RegExp(UNCERTAIN));
      assert.equal(repo.received.filter((r) => r.input.number === 13).length, before + 1);
      ok(await say("meetings", "user:alice", "incident", "Alice checks back."));
      assert.equal(
        repo.received.filter((r) => r.input.number === 13).length,
        before + 1,
        "not resent",
      );
    });

    it("14: keeps connections, their states and the sessions across a host kill and restart", async () => {
      await host.operator("revoke", { application: "review" });
      assert.deepEqual(await host.kill(), { code: null, signal: "SIGKILL" });
      host = hostProcess(config);
      await host.ready;
      assert.deepEqual(
        (await host.operator("list")).map((c) => [c.application, c.status]),
        [
          ["meetings", "active"],
          ["review", "revoked"],
        ],
      );
      const revoked = await say("review", "user:bob", "weekly", "Bob after the restart.");
      assert.equal(revoked.error.details.reason, "CONNECTION_REVOKED");
      await assert.rejects(host.operator("reconnect", { application: "review" }), /never restored/);
      const continued = ok(
        await say("meetings", "user:alice", "weekly", "Alice after the restart."),
      );
      assert.equal(continued.sessionId, alicesMeeting.sessionId);
      assert.ok(
        continued.reply.includes("Alice after the pause. | Alice after the restart."),
        continued.reply,
      );
    });
  },
);

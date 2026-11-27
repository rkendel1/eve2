import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPBOUNDRY_CLI, artifactOf, cleanup, needsAppBoundry, scratch } from "./support.mjs";
import {
  answerArgs as baseAnswerArgs,
  bindings,
  closeServers,
  deliverArgs as baseDeliverArgs,
  gate,
  hostProcess,
  organization,
  listen,
  provider,
  scriptedModel,
  sessionState,
  until,
} from "./support/production.mjs";

const run = promisify(execFile);
let org;
before(async () => {
  if (needsAppBoundry) return;
  org = await organization({ meetings: ["repo.changes.get", "repo.changes.publish"] });
  await org.grant("user:alice", ["repo.changes.get", "repo.changes.publish"]);
});
after(async () => {
  await org?.close();
  cleanup();
});
const alice = () => org.assertion("meetings", "user:alice");
const deliverArgs = (conversation, message) =>
  baseDeliverArgs(conversation, message, { assertion: alice() });
const answerArgs = (conversation, answers) =>
  baseAnswerArgs(conversation, answers, { assertion: alice() });
const INTERRUPTED = "may or may not have taken effect";
const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
};
const versions = (docs) =>
  Object.fromEntries(
    docs.map((doc) => [
      doc.sessionId,
      { version: doc.__version, lines: doc.lines, record: doc.record },
    ]),
  );

async function deployment() {
  const { path } = await artifactOf("minimal-agent");
  const clean = join(scratch("eve-deploy-"), "org-eve.app");
  mkdirSync(clean);
  for (const file of ["manifest.json", "module.wasm"])
    copyFileSync(join(path, file), join(clean, file));
  return clean;
}

describe(
  "organizational eve operated by AppBoundry's production host",
  { skip: needsAppBoundry, timeout: 1_800_000 },
  () => {
    let artifact;
    let model;
    let repo;
    let config;
    const state = () => config.state;
    before(async () => {
      artifact = await deployment();
      model = scriptedModel();
      repo = await provider({ hang: new Set([13]) });
      config = {
        artifact,
        state: join(scratch("eve-state-"), "state"),
        ...bindings({ modelUrl: await listen(model.server), providerUrl: repo.url }),
        authority: org.binding,
      };
    });
    after(closeServers);

    let first;
    let meeting;
    let asked;
    it("installs from a directory holding only the deployment output, and AppBoundry verifies it", async () => {
      assert.deepEqual(readdirSync(artifact).sort(), ["manifest.json", "module.wasm"]);
      const { stdout } = await run(
        process.execPath,
        [APPBOUNDRY_CLI, "artifact", "verify", artifact],
        { cwd: artifact },
      );
      assert.match(stdout, /program loaded in the guest: 2 functions match the manifest/);
    });

    it("opens the host with its interfaces, delivers to a new session and continues it", async () => {
      first = hostProcess({ ...config, agentIdleMs: 2_000 });
      await first.ready;
      await org.connect(first.operator, "meetings");
      assert.equal((await first.status()).agents.started, 0);
      meeting = ok(
        await first.call("eve:deliver", deliverArgs("weekly-sync", "Alice says hello.")),
      );
      assert.equal(meeting.reply, "Heard: Alice says hello.");
      assert.deepEqual(meeting.start, {
        loadMs: meeting.start.loadMs,
        restoreMs: meeting.start.restoreMs,
        restored: 0,
      });
      const two = ok(
        await first.call("eve:deliver", deliverArgs("weekly-sync", "Alice asks what was said.")),
      );
      assert.equal(two.reply, "Heard: Alice says hello. | Alice asks what was said.");
      assert.equal(two.start, undefined, "the warm instance does not start eve again");
    });

    it("invokes an authorized capability and waits for a person's approval", async () => {
      const looked = ok(
        await first.call("eve:deliver", deliverArgs("weekly-sync", "Alice asks about change 7.")),
      );
      assert.match(looked.reply, /"merged":true/);
      assert.match(repo.received.at(-1).key, new RegExp(`^${meeting.sessionId}:`));
      asked = ok(
        await first.call("eve:deliver", deliverArgs("release", "Bob asks to publish the notes.")),
      );
      assert.equal(asked.status, "awaiting-input");
      assert.equal(repo.received.filter((r) => r.capability === "repo.changes.publish").length, 0);
    });

    it("releases idle guests, and restores a session on its next delivery", async () => {
      await until(async () => (await first.status()).agents.released >= 2);
      const before = (await first.status()).agents;
      assert.equal(before.warm, 0);
      const back = ok(
        await first.call("eve:deliver", deliverArgs("weekly-sync", "Alice is back.")),
      );
      assert.equal(back.sessionId, meeting.sessionId);
      assert.ok(
        back.reply.startsWith("Heard: Alice says hello. | Alice asks what was said."),
        back.reply,
      );
      assert.equal(back.start.restored, 1);
      assert.equal((await first.status()).agents.started, before.started + 1);
    });

    let untouched;
    it("is killed while a capability call is in flight and an approval is pending", async () => {
      void first.call("eve:deliver", deliverArgs("incident", "Carol asks about change 13."));
      await until(() => repo.received.some((r) => r.input.number === 13));
      assert.deepEqual(await first.kill(), { code: null, signal: "SIGKILL" });
      const stored = await sessionState(state());
      untouched = {
        weekly: versions(stored.byLane("meetings.weekly-sync")),
        release: versions(stored.byLane("meetings.release")),
      };
      assert.equal(Object.keys(untouched.weekly).length, 1);
      assert.equal(Object.keys(untouched.release).length, 1);
      await stored.close();
    });

    let second;
    it("restarts and restores only the session it is delivered to: the uncertain call is reported, never repeated", async () => {
      second = hostProcess(config);
      await second.ready;
      const requests = model.requests.length;
      const back = ok(
        await second.call("eve:deliver", deliverArgs("incident", "Carol checks back.")),
      );
      assert.equal(back.start.restored, 1);
      assert.equal(
        repo.received.filter((r) => r.input.number === 13).length,
        1,
        "the in-flight call is not repeated",
      );
      const seen = JSON.stringify(model.requests.slice(requests));
      assert.ok(seen.includes(INTERRUPTED), "the model is told the call's outcome is uncertain");
      assert.ok(!seen.includes("Alice"), "no other conversation reaches the model");
      assert.equal((await second.status()).agents.started, 1);
    });

    it("leaves the other sessions untouched until they are delivered to", async () => {
      await second.close();
      const stored = await sessionState(state());
      assert.deepEqual(versions(stored.byLane("meetings.weekly-sync")), untouched.weekly);
      assert.deepEqual(versions(stored.byLane("meetings.release")), untouched.release);
      await stored.close();
    });

    it("keeps the pending approval through the release and the kill, and runs the approved call once", async () => {
      const third = hostProcess(config);
      await third.ready;
      const answered = ok(
        await third.call(
          "eve:answer",
          answerArgs("release", [
            { interactionId: asked.interactions[0].interactionId, optionId: "approve" },
          ]),
        ),
      );
      assert.equal(answered.status, "completed");
      assert.equal(repo.received.filter((r) => r.capability === "repo.changes.publish").length, 1);
      assert.deepEqual(await third.close(), { code: 0, signal: null });
    });

    it("shuts down cleanly with everything stored: a new host continues each conversation", async () => {
      const stored = await sessionState(state());
      for (const lane of ["meetings.weekly-sync", "meetings.release", "meetings.incident"]) {
        const [doc] = stored.byLane(lane);
        assert.ok(doc?.record, `${lane} has its record`);
        assert.equal(
          stored.lineCount(doc.sessionId),
          doc.lines,
          `${lane}'s acknowledged lines are all stored`,
        );
      }
      await stored.close();
      const fourth = hostProcess(config);
      await fourth.ready;
      const last = ok(
        await fourth.call("eve:deliver", deliverArgs("weekly-sync", "Alice says goodbye.")),
      );
      assert.ok(last.reply.includes("Alice is back. | Alice says goodbye."), last.reply);
      await fourth.close();
    });
  },
);

describe(
  "sessions on the production host: concurrency, isolation and recovery",
  { skip: needsAppBoundry, timeout: 1_800_000 },
  () => {
    let model;
    let config;
    let host;
    before(async () => {
      model = scriptedModel();
      const repo = await provider();
      config = {
        artifact: await deployment(),
        state: join(scratch("eve-state-"), "state"),
        ...bindings({ modelUrl: await listen(model.server), providerUrl: repo.url }),
        authority: org.binding,
      };
      host = hostProcess(config);
      await host.ready;
      await org.connect(host.operator, "meetings");
    });
    after(closeServers);

    it("runs two sessions independently: one waiting on its model does not hold the other", async () => {
      const slow = gate();
      model.gates.set("slow", slow);
      let aliceDone = false;
      const alice = host
        .call("eve:deliver", deliverArgs("alpha", "Alice is slow."))
        .then((r) => ((aliceDone = true), r));
      const bob = ok(await host.call("eve:deliver", deliverArgs("beta", "Bob says hi.")));
      assert.equal(bob.reply, "Heard: Bob says hi.");
      assert.equal(aliceDone, false);
      slow.open();
      assert.equal(ok(await alice).reply, "Heard: Alice is slow.");
      model.gates.delete("slow");
    });

    it("runs deliveries to one session one at a time, each seeing the one before", async () => {
      const replies = (
        await Promise.all(
          ["Carol says first.", "Carol says second."].map((m) =>
            host.call("eve:deliver", deliverArgs("gamma", m)),
          ),
        )
      ).map((r) => ok(r).reply);
      assert.equal(
        replies[0].split(" | ").length + replies[1].split(" | ").length,
        3,
        replies.join(" / "),
      );
      assert.ok(
        replies.some(
          (reply) =>
            reply.includes("Carol says first. | Carol says second.") ||
            reply.includes("Carol says second. | Carol says first."),
        ),
      );
    });

    it("finishes the turn in flight before the host closes, so a new host continues it", async () => {
      const pause = gate();
      model.gates.set("pause", pause);
      void host.call("eve:deliver", deliverArgs("delta", "Dana will pause."));
      await until(() => JSON.stringify(model.requests).includes("Dana will pause."));
      const closing = host.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      pause.open();
      assert.deepEqual(await closing, { code: 0, signal: null });
      model.gates.delete("pause");
      host = hostProcess(config);
      await host.ready;
      const back = ok(await host.call("eve:deliver", deliverArgs("delta", "Dana is back.")));
      assert.equal(back.reply, "Heard: Dana will pause. | Dana is back.");
    });

    it("refuses a session it cannot restore and leaves its records as they were", async () => {
      await host.close();
      const stored = await sessionState(config.state);
      const [doc] = stored.byLane("meetings.gamma");
      const record = JSON.parse(doc.record);
      record.checkpoint.version = 99;
      const { __version: _version, ...fields } = doc;
      await stored.write(doc, { ...fields, record: JSON.stringify(record) });
      await stored.close();
      const reread = await sessionState(config.state);
      const corrupted = reread.byLane("meetings.gamma")[0];
      await reread.close();
      host = hostProcess(config);
      await host.ready;
      const refused = await host.call("eve:deliver", deliverArgs("gamma", "Carol says third."));
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, "SESSION_UNRESTORABLE");
      assert.match(refused.error.message, /99/);
      const other = ok(await host.call("eve:deliver", deliverArgs("beta", "Bob says again.")));
      assert.equal(other.reply, "Heard: Bob says hi. | Bob says again.");
      await host.close();
      const after = await sessionState(config.state);
      assert.deepEqual(after.byLane("meetings.gamma")[0], corrupted);
      await after.close();
    });
  },
);

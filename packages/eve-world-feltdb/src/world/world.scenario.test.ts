import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFeltDB } from "@feltdb/core";
import type { QueuePrefix } from "@workflow/world";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeltDBWorld,
  createWorld,
  type FeltDBWorld,
  FeltDBWorldConfigurationError,
} from "../index.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const PREFIX = "__wkf_workflow_" as QueuePrefix;
const QUEUE = "__wkf_workflow_test" as `__wkf_workflow_${string}`;
const RETAIN = 60_000;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "eve-world-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openWorld(dir: string, retainMs = RETAIN): FeltDBWorld {
  const db = createFeltDB({
    path: join(dir, "state"),
    journal: { retainOperations: 1000, retainTransactionIdsMs: retainMs },
  });
  const world = createFeltDBWorld({ db, dataDir: dir, transactionIdRetentionMs: RETAIN });
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await world.close?.();
  });
  const close = world.close!.bind(world);
  world.close = async () => {
    closed = true;
    await close();
  };
  return world;
}

type Delivery = { message: unknown; messageId: string; deliveryCount: number };

function recordDeliveries(
  world: FeltDBWorld,
  answer: (delivery: Delivery) => unknown = () => undefined,
) {
  const deliveries: Delivery[] = [];
  const waiters: Array<() => void> = [];
  world.registerHandler(
    PREFIX,
    world.createQueueHandler(PREFIX, async (message, meta) => {
      const delivery = {
        message,
        messageId: meta.messageId,
        deliveryCount: meta.deliveryCount ?? 0,
      };
      deliveries.push(delivery);
      for (const wake of waiters.splice(0)) wake();
      return answer(delivery) as never;
    }),
  );
  const until = async (count: number, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (deliveries.length < count) {
      if (Date.now() > deadline)
        throw new Error(`expected ${count} deliveries, got ${deliveries.length}`);
      await new Promise<void>((wake) => {
        waiters.push(wake);
        setTimeout(wake, 100);
      });
    }
    return deliveries;
  };
  return { deliveries, until };
}

describe("FeltDB World", () => {
  it("refuses a database that does not bound transaction ids with the World's window", async () => {
    const dir = scratch();
    const db = createFeltDB({ path: join(dir, "state") });
    const world = createFeltDBWorld({ db, dataDir: dir });
    cleanups.push(() => world.close?.());
    await expect(world.start!()).rejects.toBeInstanceOf(FeltDBWorldConfigurationError);
  });

  it("delivers a message once it is acknowledged, then forgets it", async () => {
    const world = openWorld(scratch());
    const { until } = recordDeliveries(world);
    await world.start!();
    const { messageId } = await world.queue(QUEUE, { runId: "wrun_hello" });
    const [delivery] = await until(1);
    expect(delivery).toMatchObject({
      messageId,
      deliveryCount: 1,
      message: { runId: "wrun_hello" },
    });
  });

  it("deduplicates a keyed send while its message is alive", async () => {
    const world = openWorld(scratch());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const { until } = recordDeliveries(world, async () => held);
    await world.start!();
    const first = await world.queue(QUEUE, { runId: "wrun_one" }, { idempotencyKey: "same" });
    const second = await world.queue(QUEUE, { runId: "wrun_two" }, { idempotencyKey: "same" });
    expect(second.messageId).toBe(first.messageId);
    await until(1);
    release();
  });

  it("redelivers on { timeoutSeconds } with the same message id and a higher delivery count", async () => {
    const world = openWorld(scratch());
    const { until } = recordDeliveries(world, (delivery) =>
      delivery.deliveryCount === 1 ? { timeoutSeconds: 1 } : undefined,
    );
    await world.start!();
    const { messageId } = await world.queue(QUEUE, { runId: "wrun_step" });
    const deliveries = await until(2);
    expect(deliveries.map((delivery) => delivery.messageId)).toEqual([messageId, messageId]);
    expect(deliveries.map((delivery) => delivery.deliveryCount)).toEqual([1, 2]);
  });

  it("keeps a delayed message across close and delivers it after reopening", async () => {
    const dir = scratch();
    const first = openWorld(dir);
    recordDeliveries(first);
    await first.start!();
    const { messageId } = await first.queue(QUEUE, { runId: "wrun_later" }, { delaySeconds: 2 });
    await first.close!();

    const second = openWorld(dir);
    const { until } = recordDeliveries(second);
    await second.start!();
    const [delivery] = await until(1);
    expect(delivery).toMatchObject({ messageId, message: { runId: "wrun_later" } });
  });

  it("redelivers a message whose process was killed mid-delivery, with the same id and a higher count", async () => {
    const dir = scratch();
    const script = join(packageRoot, `.world-kill-${process.pid}.mjs`);
    writeFileSync(
      script,
      `
      import { createFeltDB } from "@feltdb/core";
      import { createFeltDBWorld } from ${JSON.stringify(join(packageRoot, "dist/index.js"))};
      const dir = process.argv[2];
      const db = createFeltDB({ path: dir + "/state", journal: { retainOperations: 1000, retainTransactionIdsMs: ${RETAIN} } });
      const world = createFeltDBWorld({ db, dataDir: dir, transactionIdRetentionMs: ${RETAIN} });
      world.registerHandler("__wkf_workflow_", world.createQueueHandler("__wkf_workflow_", async (message, meta) => {
        console.log("delivering " + meta.messageId + " " + meta.deliveryCount);
        await new Promise(() => {});
      }));
      await world.start();
      await world.queue("__wkf_workflow_test", { runId: "wrun_survives" });
      setInterval(() => {}, 1 << 30);
      `,
    );
    cleanups.push(() => rmSync(script, { force: true }));
    const killed = await new Promise<{ messageId: string; deliveryCount: number }>(
      (resolveKilled, reject) => {
        const child = spawn(process.execPath, [script, dir], {
          cwd: packageRoot,
          stdio: ["ignore", "pipe", "inherit"],
        });
        let seen: { messageId: string; deliveryCount: number } | undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          const match = /delivering (\S+) (\d+)/.exec(String(chunk));
          if (match && !seen) {
            seen = { messageId: match[1]!, deliveryCount: Number(match[2]) };
            child.kill("SIGKILL");
          }
        });
        child.once("close", () => {
          if (seen) resolveKilled(seen);
          else reject(new Error("the child never delivered"));
        });
      },
    );

    const world = openWorld(dir);
    const { until } = recordDeliveries(world);
    await world.start!();
    const [delivery] = await until(1);
    expect(delivery!.messageId).toBe(killed.messageId);
    expect(delivery!.deliveryCount).toBeGreaterThan(killed.deliveryCount);
    expect(delivery!.message).toEqual({ runId: "wrun_survives" });
  });

  it("stores a stream in order, closes it, and reads it back after reopening", async () => {
    const dir = scratch();
    const first = openWorld(dir);
    await first.start!();
    await first.streams.writeMulti!("wrun_streams", "strm_out", ["a", "b"]);
    await first.streams.write("wrun_streams", "strm_out", "c");
    await first.streams.close("wrun_streams", "strm_out");
    await first.close!();

    const second = openWorld(dir);
    await second.start!();
    const chunks = await second.streams.getChunks("wrun_streams", "strm_out", { limit: 10 });
    expect(chunks.done).toBe(true);
    expect(chunks.data.map((chunk) => new TextDecoder().decode(chunk.data))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(await second.streams.getInfo("wrun_streams", "strm_out")).toEqual({
      tailIndex: 2,
      done: true,
    });
    expect(await second.streams.list("wrun_streams")).toEqual(["strm_out"]);
    const reader = (await second.streams.get("wrun_streams", "strm_out", 1)).getReader();
    const read: string[] = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      read.push(new TextDecoder().decode(next.value));
    }
    expect(read).toEqual(["b", "c"]);
  });
});

describe("createWorld's ownership of its directory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function ownedBy(dir: string, waitMs: number) {
    vi.stubEnv("EVE_FELTDB_PATH", dir);
    vi.stubEnv("EVE_FELTDB_OWNER_WAIT_MS", String(waitMs));
  }

  async function ownerProcess(dir: string) {
    const script = join(packageRoot, `.world-owner-${process.pid}.mjs`);
    writeFileSync(
      script,
      `
      import { createWorld } from ${JSON.stringify(join(packageRoot, "dist/index.js"))};
      await createWorld();
      console.log("owning");
      setInterval(() => {}, 1 << 30);
      `,
    );
    cleanups.push(() => rmSync(script, { force: true }));
    const child = spawn(process.execPath, [script], {
      cwd: packageRoot,
      env: { ...process.env, EVE_FELTDB_PATH: dir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    await new Promise<void>((resolveOwning, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("owning")) resolveOwning();
      });
      child.once("close", () => reject(new Error("the owner exited before owning the directory")));
    });
    return child;
  }

  it("refuses a directory another live process owns, after the owner wait", async () => {
    const dir = scratch();
    await ownerProcess(dir);
    ownedBy(dir, 300);
    const started = Date.now();
    await expect(createWorld()).rejects.toMatchObject({ code: "STATE_LOCKED" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("takes a directory over from an owner killed while it waits", async () => {
    const dir = scratch();
    const owner = await ownerProcess(dir);
    ownedBy(dir, 15_000);
    const successor = createWorld();
    await new Promise((resolve) => setTimeout(resolve, 500));
    owner.kill("SIGKILL");
    const world = await successor;
    cleanups.push(() => world.close?.());
    expect(world).toBeDefined();
  });

  it("names a wait that is not a nonnegative integer", async () => {
    ownedBy(scratch(), 0);
    vi.stubEnv("EVE_FELTDB_OWNER_WAIT_MS", "soon");
    await expect(createWorld()).rejects.toThrow(FeltDBWorldConfigurationError);
    await expect(createWorld()).rejects.toThrow(
      /EVE_FELTDB_OWNER_WAIT_MS must be a nonnegative integer/,
    );
  });
});

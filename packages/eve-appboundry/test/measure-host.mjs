import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactOf, CHECKOUT, cleanup, scratch } from "./support.mjs";
import {
  alice,
  bindings,
  closeServers,
  deliverArgs,
  listen,
  provider,
  scriptedModel,
  until,
} from "./support/production.mjs";

const keepalive = setInterval(() => {}, 1 << 30);
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const { ArtifactHost, loadArtifact } = await import(
  pathToFileURL(join(CHECKOUT, "packages/appboundry-host/dist/index.js")).href
);
const { path } = await artifactOf("minimal-agent");
const model = scriptedModel();
const repo = await provider();
const AGENT_IDLE_MS = 3_000;

let t = performance.now();
const artifact = await loadArtifact(path);
const loadArtifactMs = performance.now() - t;
t = performance.now();
const host = await ArtifactHost.open({
  artifact,
  stateDir: join(scratch("eve-measure-"), "state"),
  jobIntervalMs: 0,
  agentIdleMs: AGENT_IDLE_MS,
  ...bindings({ modelUrl: await listen(model.server), providerUrl: repo.url }),
  logger: { info() {}, warn() {}, error() {} },
});
const openMs = performance.now() - t;
const agents = async () => (await host.status()).runtime.guests;
const deliver = async (conversation, message) => {
  const started = performance.now();
  const result = await host.call("eve:deliver", deliverArgs(conversation, message), {
    principal: alice,
    via: "measure",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return {
    ms: Math.round(performance.now() - started),
    value: result.value,
    lane: (await agents()).agents.startMs.last,
  };
};
const memory = async () => ({
  rssMB: mb(process.memoryUsage().rss),
  guestPeakMB: mb((await agents()).peakMemoryBytes),
});

const out = {
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    totalMemoryMB: mb(totalmem()),
  },
  artifact: {
    moduleBytes: artifact.manifest.module.size,
    programBytes: artifact.manifest.module.program.size,
  },
  host: {
    loadArtifactMs: Math.round(loadArtifactMs),
    openMs: Math.round(openMs),
    memoryAfterOpen: await memory(),
  },
};

const first = await deliver("alpha", "Alice says hello.");
out.newSession = {
  deliveryMs: first.ms,
  instanceStartMs: first.lane,
  eveStart: first.value.start,
  memory: await memory(),
};
const warm = await deliver("alpha", "Alice says more.");
out.warmDeliveryMs = warm.ms;

t = performance.now();
const concurrent = await Promise.all([
  deliver("beta", "Bob says hello."),
  deliver("gamma", "Carol says hello."),
  deliver("alpha", "Alice again."),
]);
out.concurrent = {
  wallMs: Math.round(performance.now() - t),
  deliveriesMs: concurrent.map((c) => c.ms),
  warm: (await agents()).agents.warm,
  memory: await memory(),
};

for (let i = 0; i < 20; i++) await deliver("delta", `Dana says ${i}.`);
await until(async () => (await agents()).agents.warm === 0, 120_000);
globalThis.gc?.();
out.afterIdleRelease = { released: (await agents()).agents.released, memory: await memory() };

const restoredSmall = await deliver("alpha", "Alice is back.");
out.restoreExisting = {
  lines: "4 turns",
  deliveryMs: restoredSmall.ms,
  instanceStartMs: restoredSmall.lane,
  eveStart: restoredSmall.value.start,
};
const restoredLarge = await deliver("delta", "Dana is back.");
out.restoreLarger = {
  lines: "20 turns",
  deliveryMs: restoredLarge.ms,
  instanceStartMs: restoredLarge.lane,
  eveStart: restoredLarge.value.start,
};
out.limits = {
  maxMemoryMB: mb((await agents()).memoryPolicy.maxMemoryBytes),
  memoryLimitFaults: (await agents()).memoryLimits,
};

await host.close();
await closeServers();
cleanup();
clearInterval(keepalive);
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);

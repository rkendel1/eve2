import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const config = JSON.parse(process.argv[2]);
const { ArtifactHost, loadArtifact } = await import(
  pathToFileURL(join(config.checkout, "packages/appboundry-host/dist/index.js")).href
);
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const keepalive = setInterval(() => {}, 1 << 30);
const host = await ArtifactHost.open({
  artifact: await loadArtifact(config.artifact),
  stateDir: config.state,
  jobIntervalMs: 0,
  agentIdleMs: config.agentIdleMs,
  modelBinding: config.modelBinding,
  capabilityBindings: config.capabilityBindings,
  ...(config.authority ? { authority: config.authority } : {}),
  logger: {
    info() {},
    warn: (message) => say({ warn: message }),
    error: (message) => say({ error: message }),
  },
});
say({ opened: true, pid: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.op === "call") {
    void host
      .call(command.fn, command.args, {
        principal: command.principal,
        via: "eve-appboundry lifecycle",
      })
      .then((result) => say({ id: command.id, result }));
  } else if (command.op === "operator") {
    const operator = { kind: "local", name: "lifecycle" };
    try {
      const value =
        command.action === "user"
          ? await host.admin((a) => a.addUser(operator, command.input))
          : command.action === "connect"
            ? await host.connectApplication(operator, command.input)
            : command.action === "list"
              ? await host.listConnections()
              : await host.changeConnection(operator, command.action, command.input.application);
      say({ id: command.id, value });
    } catch (error) {
      say({ id: command.id, error: { code: error.code, message: error.message } });
    }
  } else if (command.op === "outbound") {
    say({ id: command.id, value: await host.outbound() });
  } else if (command.op === "status") {
    say({ id: command.id, status: (await host.status()).runtime.guests });
  } else if (command.op === "close") {
    await host.close();
    say({ id: command.id, closed: true });
    clearInterval(keepalive);
    process.exit(0);
  }
}

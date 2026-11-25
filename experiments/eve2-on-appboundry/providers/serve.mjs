// Shared AppPort serving for the providers: one consumer credential (issued by the provider, held by the host),
// a JSON line per event on stdout, and nothing else.
import { createServer as createHttpServer } from "node:http";
import { createApplication } from "@appport/core";
import { createHttpBinding, createServer } from "@appport/server";
import { createNodeRequestListener } from "@appport/server/node";

export const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);

export function serve({ id, name, capabilities, port, consumerToken, control }) {
  if (!consumerToken) throw new Error(`${id}: a consumer token is required (the credential this provider issues to its consumer)`);
  const application = createApplication({ application: { id, name, version: "1.0.0" }, capabilities });
  const appport = createNodeRequestListener(createHttpBinding({ server: createServer({ application, authenticate: () => ({ principal: { id: "consumer", type: "application" } }) }) }));
  const server = createHttpServer(async (req, res) => {
    if (control && req.url?.startsWith("/__control") && req.socket.remoteAddress === "127.0.0.1") return control(req, res);
    if (req.headers.authorization !== `Bearer ${consumerToken}`) { log("refused.unauthenticated", { path: req.url }); res.writeHead(401).end(); return; }
    appport(req, res);
  });
  server.listen(port, "127.0.0.1", () => log("listening", { id, port }));
  return server;
}

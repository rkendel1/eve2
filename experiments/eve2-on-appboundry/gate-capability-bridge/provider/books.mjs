// An AppPort provider process. It issues one credential to its consumer and keeps its own invoice ledger.
// POST /__control { delayMs } makes the next create answer late (after it has taken effect): a target-system timeout.
import { createServer as createHttpServer } from "node:http";
import { createApplication, defineCapability } from "@appport/core";
import { AppPortError } from "@appport/protocol";
import { s } from "@appport/schema";
import { createHttpBinding, createServer } from "@appport/server";
import { createNodeRequestListener } from "@appport/server/node";

const port = Number(process.env.PORT ?? 5301);
const token = process.env.BOOKS_CONSUMER_TOKEN;
if (!token) throw new Error("BOOKS_CONSUMER_TOKEN is required");
const invoices = new Map();
const byKey = new Map();
let delayNext = 0;
const log = (event, fields) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);

const application = createApplication({
  application: { id: "books", name: "Books", version: "1.0.0" },
  capabilities: [
    defineCapability({
      name: "books.invoices.create", version: 1, description: "Create an invoice in the books",
      input: s.object({ amount: s.number() }), output: s.object({ id: s.string(), amount: s.number() }), authorization: [], idempotency: "supported",
      handler: async (input, context) => {
        if (!(input.amount > 0)) throw new AppPortError("INVALID_INPUT", "amount must be positive");
        const key = context.idempotencyKey;
        if (key && byKey.has(key)) { log("create.replayed", { key }); return invoices.get(byKey.get(key)); }
        const invoice = { id: `inv-${invoices.size + 1}`, amount: input.amount };
        invoices.set(invoice.id, invoice);
        if (key) byKey.set(key, invoice.id);
        log("create.committed", { key, id: invoice.id, principal: context.principal?.id });
        if (delayNext) { const ms = delayNext; delayNext = 0; await new Promise(r => setTimeout(r, ms)); }
        return invoice;
      },
    }),
    defineCapability({ name: "books.invoices.void", version: 1, input: s.object({ id: s.string() }), output: s.object({ ok: s.boolean() }), authorization: [], handler: async () => ({ ok: true }) }),
  ],
});
const appport = createNodeRequestListener(createHttpBinding({ server: createServer({ application, authenticate: () => ({ principal: { id: "ledgerbridge", type: "application" } }) }) }));
createHttpServer(async (req, res) => {
  if (req.url === "/__state") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ invoices: [...invoices.values()] })); return; }
  if (req.url === "/__control" && req.method === "POST") { let b = ""; for await (const c of req) b += c; delayNext = JSON.parse(b).delayMs ?? 0; res.writeHead(204).end(); return; }
  // The provider's own authentication: only the credential it issued reaches a capability.
  if (req.headers.authorization !== `Bearer ${token}`) { log("refused.unauthenticated", { path: req.url }); res.writeHead(401).end(); return; }
  appport(req, res);
}).listen(port, "127.0.0.1", () => log("listening", { port }));

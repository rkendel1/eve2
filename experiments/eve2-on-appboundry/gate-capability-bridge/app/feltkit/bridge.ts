import { s } from "@feltdb/feltkit";
import { app, attempts } from "./app.js";

/** What the host says this application may reach. */
export const available = app.query({ access: "bridge.read", handler: (ctx) => ctx.capabilities.list() });

/** Post an invoice through a declared requirement, and keep what happened in the application's own state. */
export const post = app.mutation({
  access: "bridge.write",
  args: { key: s.string(), amount: s.number(), capability: s.optional(s.string()) },
  handler: async (ctx, { key, amount, capability }) => {
    const result = await ctx.capabilities.invoke<{ id: string }>(capability ?? "books.invoices.create", { amount }, { idempotencyKey: key });
    const detail = result.outcome === "succeeded" ? result.value.id : result.outcome === "unknown" ? result.reason : result.error.code;
    await ctx.db.insert(attempts, { key, outcome: result.outcome, detail });
    return result;
  },
});

export const history = app.query({ access: "bridge.read", handler: (ctx) => ctx.db.find(attempts, {}) });

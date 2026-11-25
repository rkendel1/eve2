import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "ledgerbridge",
  roles: { member: ["bridge.*"] },
  dev: { users: [{ id: "ada", roles: ["member"] }] },
  requires: [
    { name: "books.invoices.create", versions: "1", purpose: "post approved invoices" },
    { name: "books.invoices.void", versions: "1", optional: true },
  ],
});
export const attempts = app.collection("attempts", { key: s.string(), outcome: s.string(), detail: s.string() });

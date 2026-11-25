// finance.* over QuickBooks Online (sandbox by default). The provider holds the OAuth relationship with Intuit; Eve2
// never sees a token, a realm or an endpoint.
//
//   QBO_REALM_ID          the sandbox company
//   QBO_TOKEN_FILE        where the current refresh token is kept (Intuit rotates it); seeded from QBO_REFRESH_TOKEN
//   QBO_CLIENT_ID/SECRET  the Intuit app (or a network secret for oauth.platform.intuit.com, added by the proxy)
//   QBO_BASE_URL          default https://sandbox-quickbooks.api.intuit.com
//
// Faults are injected here, at the provider boundary, against the real system (POST /__control):
//   { "answerCreateAfterMs": n }  the next bill is created in QuickBooks, and the answer is held n ms (a timeout after effect)
//   { "failNextGet": true }       the next read-back fails before reaching QuickBooks
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineCapability } from "@appport/core";
import { AppPortError } from "@appport/protocol";
import { s } from "@appport/schema";
import { log, serve } from "./serve.mjs";

const REALM = process.env.QBO_REALM_ID;
const BASE = process.env.QBO_BASE_URL ?? "https://sandbox-quickbooks.api.intuit.com";
const TOKEN_FILE = process.env.QBO_TOKEN_FILE ?? ".qbo-token.json";
const MINOR = 75;
const faults = { answerCreateAfterMs: 0, failNextGet: false };
let access = { token: null, expiresAt: 0 };

function refreshToken() {
  if (existsSync(TOKEN_FILE)) return JSON.parse(readFileSync(TOKEN_FILE, "utf8")).refreshToken;
  return process.env.QBO_REFRESH_TOKEN;
}
async function accessToken() {
  if (access.token && Date.now() < access.expiresAt - 60_000) return access.token;
  const refresh = refreshToken();
  if (!refresh || !REALM) throw new AppPortError("UNAVAILABLE", "QuickBooks is not connected: no realm or refresh token for this provider.");
  const basic = process.env.QBO_CLIENT_ID ? `Basic ${Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString("base64")}` : "Basic aW5qZWN0ZWQ6Ynlwcm94eQ==";
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST", headers: { authorization: basic, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { log("qbo.token.error", { status: response.status, error: body.error }); throw new AppPortError("UNAVAILABLE", `QuickBooks token refresh failed (${body.error ?? response.status}).`); }
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: body.refresh_token, rotatedAt: new Date().toISOString() }), { mode: 0o600 });
  access = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  log("qbo.token.refreshed", { expiresIn: body.expires_in });
  return access.token;
}

async function qbo(method, path, { body, requestId } = {}) {
  const url = new URL(`${BASE}/v3/company/${REALM}${path}`);
  url.searchParams.set("minorversion", String(MINOR));
  if (requestId) url.searchParams.set("requestid", requestId);
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json().catch(() => ({}));
  const intuitTid = response.headers.get("intuit_tid");
  if (!response.ok || json.Fault) {
    const error = json.Fault?.Error?.[0];
    log("qbo.error", { method, path, status: response.status, intuitTid, code: error?.code, message: error?.Message, detail: error?.Detail });
    if (response.status === 401) access = { token: null, expiresAt: 0 };
    const code = response.status === 400 ? "INVALID_INPUT" : response.status === 401 || response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
    throw new AppPortError(code, `QuickBooks ${error?.Message ?? response.status}${error?.Detail ? `: ${error.Detail}` : ""}`);
  }
  log("qbo.call", { method, path, status: response.status, intuitTid });
  return json;
}
const quote = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const query = async (q) => (await qbo("GET", `/query?query=${encodeURIComponent(q)}`)).QueryResponse ?? {};
const onlyBills = (kind) => { if (kind !== "bill") throw new AppPortError("INVALID_INPUT", `This provider records vendor bills; ${kind} is not supported.`); };
const toDocument = (b) => ({
  id: b.Id, kind: "bill", reference: b.DocNumber, partyId: b.VendorRef?.value, partyName: b.VendorRef?.name, total: b.TotalAmt, currency: b.CurrencyRef?.value, date: b.TxnDate,
  lines: (b.Line ?? []).filter((l) => l.DetailType === "AccountBasedExpenseLineDetail").map((l) => ({ accountId: l.AccountBasedExpenseLineDetail.AccountRef.value, amount: l.Amount, description: l.Description })),
  syncToken: b.SyncToken, createdAt: b.MetaData?.CreateTime,
});

const capabilities = [
  defineCapability({
    name: "finance.parties.find", version: 1, description: "Find vendors (or customers) by name.",
    input: s.object({ name: s.string(), role: s.enum(["vendor", "customer"]) }), output: s.object({ matches: s.unknown() }), authorization: [],
    handler: async ({ name, role }) => {
      const entity = role === "vendor" ? "Vendor" : "Customer";
      let rows = (await query(`select * from ${entity} where DisplayName = ${quote(name)}`))[entity] ?? [];
      if (!rows.length) rows = (await query(`select * from ${entity} where DisplayName like ${quote(`%${name}%`)}`))[entity] ?? [];
      return { matches: rows.map((r) => ({ id: r.Id, name: r.DisplayName })) };
    },
  }),
  defineCapability({
    name: "finance.accounts.find", version: 1, description: "Find active expense (or income) accounts whose name contains the given words.",
    input: s.object({ name: s.string(), purpose: s.enum(["expense", "income"]) }), output: s.object({ matches: s.unknown() }), authorization: [],
    handler: async ({ name, purpose }) => {
      const types = purpose === "expense" ? ["Expense", "Other Expense", "Cost of Goods Sold"] : ["Income", "Other Income"];
      const rows = (await query(`select * from Account where Active = true`)).Account ?? [];
      const words = name.toLowerCase().replace(/\bexpenses?\b/g, "").split(/\s+/).filter(Boolean);
      const candidates = rows.filter((a) => types.includes(a.AccountType));
      const exact = candidates.filter((a) => a.Name.toLowerCase() === name.toLowerCase());
      const matches = exact.length ? exact : candidates.filter((a) => words.length && words.every((w) => a.Name.toLowerCase().includes(w)));
      return { matches: matches.map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType })) };
    },
  }),
  defineCapability({
    name: "finance.documents.find", version: 1, description: "Find bills by our reference (DocNumber), or by vendor and amount.",
    input: s.object({ kind: s.string(), reference: s.optional(s.string()), partyId: s.optional(s.string()), amount: s.optional(s.number()), vendorReference: s.optional(s.string()) }), output: s.object({ matches: s.unknown() }), authorization: [],
    handler: async ({ kind, reference, partyId, amount }) => {
      onlyBills(kind);
      const rows = reference ? (await query(`select * from Bill where DocNumber = ${quote(reference)}`)).Bill ?? []
        : partyId ? (await query(`select * from Bill where VendorRef = ${quote(partyId)} maxresults 200`)).Bill ?? [] : [];
      return { matches: rows.map(toDocument).filter((d) => amount === undefined || Math.abs(d.total - amount) < 0.005) };
    },
  }),
  defineCapability({
    name: "finance.documents.create", version: 1, description: "Record a vendor bill. Idempotent on the AppPort idempotency key (Intuit requestid).",
    input: s.object({ kind: s.string(), partyId: s.string(), reference: s.string(), vendorReference: s.optional(s.string()), date: s.optional(s.string()), currency: s.string(), memo: s.string(), lines: s.array(s.object({ accountId: s.string(), amount: s.number(), description: s.string() })) }),
    output: s.unknown(), authorization: [], idempotency: "required",
    handler: async (input, context) => {
      onlyBills(input.kind);
      const requestId = createHash("sha256").update(context.idempotencyKey ?? JSON.stringify(input)).digest("hex").slice(0, 36);
      const created = await qbo("POST", "/bill", {
        requestId,
        body: {
          VendorRef: { value: input.partyId }, DocNumber: input.reference, PrivateNote: `${input.memo}${input.vendorReference ? ` (vendor invoice ${input.vendorReference})` : ""}`,
          ...(input.date ? { TxnDate: input.date } : {}),
          Line: input.lines.map((l) => ({ DetailType: "AccountBasedExpenseLineDetail", Amount: l.amount, Description: l.description, AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId } } })),
        },
      });
      log("bill.created", { id: created.Bill.Id, docNumber: created.Bill.DocNumber, requestId });
      if (faults.answerCreateAfterMs) { const ms = faults.answerCreateAfterMs; faults.answerCreateAfterMs = 0; log("fault.holding-answer", { ms }); await new Promise((r) => setTimeout(r, ms)); }
      return toDocument(created.Bill);
    },
  }),
  defineCapability({
    name: "finance.documents.get", version: 1, description: "Read a bill back from QuickBooks.",
    input: s.object({ kind: s.string(), id: s.string() }), output: s.unknown(), authorization: [],
    handler: async ({ kind, id }) => {
      onlyBills(kind);
      if (faults.failNextGet) { faults.failNextGet = false; throw new AppPortError("UNAVAILABLE", "Injected: QuickBooks read-back failed."); }
      return toDocument((await qbo("GET", `/bill/${encodeURIComponent(id)}`)).Bill);
    },
  }),
];

serve({
  id: "quickbooks", name: "QuickBooks Online", capabilities, port: Number(process.env.PORT ?? 5430), consumerToken: process.env.CONSUMER_TOKEN,
  control: async (req, res) => { let b = ""; for await (const c of req) b += c; Object.assign(faults, JSON.parse(b || "{}")); log("fault.set", faults); res.writeHead(204).end(); },
});
accessToken().then(() => query("select * from CompanyInfo")).then((r) => log("qbo.company", { name: r.CompanyInfo?.[0]?.CompanyName, realm: REALM }), (e) => log("qbo.unavailable", { message: e.message }));

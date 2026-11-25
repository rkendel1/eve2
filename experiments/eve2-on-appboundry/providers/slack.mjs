// conversation.messages.get@1 and conversation.messages.reply@1 over the Slack Web API, plus the source side of the
// integration: it watches one channel and delivers each request (and each later change to it: an edit, a reaction, a
// reply in its thread) to Eve2's tasks:submit, as the operator-issued `source` session.
//
// Slack access: the bot token is the provider's, never Eve2's. In a cloud environment with a network secret for
// slack.com the proxy adds it to each request; elsewhere SLACK_BOT_TOKEN is read. Scopes: channels:history,
// chat:write, reactions:read (groups:history for a private channel).
import { createHash } from "node:crypto";
import { defineCapability } from "@appport/core";
import { AppPortError } from "@appport/protocol";
import { s } from "@appport/schema";
import { log, serve } from "./serve.mjs";

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-injected-by-proxy";
const CHANNEL = process.env.SLACK_CHANNEL_ID;
const EVE_URL = process.env.EVE_URL;
const EVE_SOURCE_TOKEN = process.env.EVE_SOURCE_TOKEN;
const POLL_MS = Number(process.env.SLACK_POLL_MS ?? 5000);
const faults = { delayReplyMs: 0 };

async function slack(method, params, { post = false } = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  const init = { headers: { authorization: `Bearer ${TOKEN}` } };
  if (post) Object.assign(init, { method: "POST", headers: { ...init.headers, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(params) });
  else for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));
  if (!body.ok) {
    log("slack.error", { method, error: body.error });
    const code = ["not_authed", "invalid_auth", "missing_scope", "not_in_channel", "channel_not_found"].includes(body.error) ? "FORBIDDEN" : body.error === "message_not_found" ? "NOT_FOUND" : body.error === "ratelimited" ? "RATE_LIMITED" : "INTERNAL_ERROR";
    throw new AppPortError(code, `Slack ${method}: ${body.error}`);
  }
  return body;
}

const toMessage = (m) => ({ id: m.ts, author: { id: m.user ?? m.bot_id ?? "unknown" }, text: m.text ?? "", ...(m.edited ? { editedAt: m.edited.ts } : {}), reactions: (m.reactions ?? []).map((r) => ({ name: r.name, users: r.users ?? [] })) });

async function readMessage(conversation, ts) {
  const history = await slack("conversations.history", { channel: conversation, latest: ts, oldest: ts, inclusive: true, limit: 1 });
  const parent = history.messages?.find((m) => m.ts === ts);
  if (!parent) throw new AppPortError("NOT_FOUND", `No message ${ts} in ${conversation}.`);
  const replies = parent.reply_count ? (await slack("conversations.replies", { channel: conversation, ts, limit: 200 })).messages.filter((m) => m.ts !== ts) : [];
  return { ...toMessage(parent), conversation, thread: replies.map((m) => ({ id: m.ts, author: { id: m.user ?? m.bot_id ?? "unknown" }, text: m.text ?? "" })) };
}

const get = defineCapability({
  name: "conversation.messages.get", version: 1,
  description: "Read one message with its reactions and its thread replies.",
  input: s.object({ conversation: s.string(), message: s.string() }),
  output: s.unknown(), authorization: [], idempotency: "supported",
  handler: async ({ conversation, message }) => readMessage(conversation, message),
});

const reply = defineCapability({
  name: "conversation.messages.reply", version: 1,
  description: "Reply in the thread of a message.",
  input: s.object({ conversation: s.string(), message: s.string(), text: s.string() }),
  output: s.object({ id: s.string() }), authorization: [], idempotency: "supported",
  handler: async ({ conversation, message, text }) => {
    const posted = await slack("chat.postMessage", { channel: conversation, thread_ts: message, text, unfurl_links: false }, { post: true });
    if (faults.delayReplyMs) { const ms = faults.delayReplyMs; faults.delayReplyMs = 0; await new Promise((r) => setTimeout(r, ms)); }
    return { id: posted.ts };
  },
});

// The source: poll the channel; deliver new top-level requests, and any change to one already delivered.
const seen = new Map();
async function poll() {
  if (!CHANNEL || !EVE_URL || !EVE_SOURCE_TOKEN) return;
  try {
    const history = await slack("conversations.history", { channel: CHANNEL, limit: 50 });
    for (const m of history.messages ?? []) {
      if (m.bot_id || m.subtype || m.thread_ts && m.thread_ts !== m.ts) continue;
      const replies = m.reply_count ? (await slack("conversations.replies", { channel: CHANNEL, ts: m.ts, limit: 200 })).messages.filter((r) => r.ts !== m.ts && !r.bot_id) : [];
      const fingerprint = createHash("sha256").update(JSON.stringify([m.text, m.edited?.ts, m.reactions, replies.map((r) => [r.user, r.text])])).digest("hex");
      if (seen.get(m.ts) === fingerprint) continue;
      seen.set(m.ts, fingerprint);
      const response = await fetch(`${EVE_URL}/api/mutation/tasks:submit`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${EVE_SOURCE_TOKEN}` }, body: JSON.stringify({ args: { source: { system: "slack", conversation: CHANNEL, message: m.ts } } }) });
      log("delivered", { ts: m.ts, status: response.status, result: await response.json().catch(() => null) });
    }
  } catch (error) {
    log("poll.error", { message: String(error.message ?? error) });
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

serve({
  id: "slack", name: "Slack", capabilities: [get, reply], port: Number(process.env.PORT ?? 5420), consumerToken: process.env.CONSUMER_TOKEN,
  control: async (req, res) => { let b = ""; for await (const c of req) b += c; Object.assign(faults, JSON.parse(b || "{}")); log("fault.set", faults); res.writeHead(204).end(); },
});
await slack("auth.test", {}).then((r) => log("slack.identity", { team: r.team, user: r.user, bot: r.bot_id }), (e) => log("slack.unavailable", { message: e.message }));
poll();

/**
 * Eve2: an integration operator. It takes responsibility for moving a request from a source system into a
 * destination system, makes sure the result is correct, and reports it. It holds no credentials and has no network:
 * everything outside its own state is a capability it declares here and the host binds (AppBoundry capabilities@1).
 *
 * The contracts are generic. Slack or a chat app provides `conversation.*`; QuickBooks or another ledger provides
 * `finance.*`; a model provider provides `reasoning.interpret`. Swapping a system is a new binding, not new code.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "eve2",
  version: "0.1.0",
  description: "Integration operator: takes a request from a source system into a destination system, verifies it, and reports.",
  roles: {
    // A source connector delivers requests (and their later changes: approvals, edits, replies). Eve's steps run as
    // jobs enqueued by the call that delivered the request, so the connector also holds tasks.advance.
    source: ["tasks.submit", "tasks.advance", "tasks.read"],
    // People who operate Eve: they set the policies that bound what it may do, and read everything it did.
    operator: ["tasks.*", "policies.*"],
  },
  dev: {
    users: [
      { id: "operator", name: "Operator", roles: ["operator"] },
      { id: "source-connector", name: "Source connector", type: "service", roles: ["source"] },
    ],
  },
  services: { jobs: { handlers: { "eve.advance": "tasks:advance" } } },
  requires: [
    { name: "conversation.messages.get", versions: "1", purpose: "read the request, its thread and its approvals" },
    { name: "conversation.messages.reply", versions: "1", purpose: "ask for what is missing and report the outcome where the request was made" },
    { name: "reasoning.interpret", versions: "1", purpose: "turn a person's request into a structured intent" },
    { name: "finance.parties.find", versions: "1", purpose: "resolve the vendor or customer a request names" },
    { name: "finance.accounts.find", versions: "1", purpose: "resolve the category a request names" },
    { name: "finance.documents.find", versions: "1", purpose: "detect duplicates and reconcile uncertain outcomes" },
    { name: "finance.documents.create", versions: "1", purpose: "record the approved document" },
    { name: "finance.documents.get", versions: "1", purpose: "verify the recorded document independently" },
  ],
});

/** Statuses a task moves through. Waiting statuses resume when the source delivers a change. */
export const STATUSES = [
  "received", "authorizing", "resolving", "ready", "reconciling", "verifying", "reporting",
  "needs_clarification", "needs_approval", "blocked",
  "completed", "verification_failed", "failed",
] as const;

/** The request Eve took responsibility for. */
export const tasks = app.collection("tasks", {
  sourceKey: s.string(),
  source: s.object({ system: s.string(), conversation: s.string(), message: s.string() }),
  status: s.enum(STATUSES),
  /** What Eve is waiting for, or why it stopped, in words for the person who asked. */
  openQuestion: s.optional(s.string()),
  /** Digest of the source message as last interpreted: a change re-opens the interpretation. */
  sourceDigest: s.optional(s.string()),
  intent: s.optional(s.unknown()),
  plan: s.optional(s.unknown()),
  planDigest: s.optional(s.string()),
  /** The destination's reference Eve puts on the document: how it finds the document again, whatever happened. */
  reference: s.string(),
  target: s.optional(s.object({ id: s.string(), kind: s.string() })),
  attempts: s.number(),
  steps: s.number(),
  createdAt: s.string(),
  updatedAt: s.string(),
}, { unique: [["sourceKey"]] });

/** What Eve did, one record per step: what it observed, decided and invoked, and what came back. */
export const executions = app.collection("executions", {
  taskId: s.string(),
  seq: s.number(),
  at: s.string(),
  from: s.string(),
  to: s.string(),
  kind: s.enum(["observe", "decide", "invoke", "verify", "report", "wait"] as const),
  summary: s.string(),
  capability: s.optional(s.string()),
  idempotencyKey: s.optional(s.string()),
  outcome: s.optional(s.string()),
  outboundId: s.optional(s.string()),
  detail: s.optional(s.unknown()),
});

/** Facts Eve relies on, as captured: the source record, the approval, the target record, the verification, model usage. */
export const evidence = app.collection("evidence", {
  taskId: s.string(),
  kind: s.enum(["source_record", "approval", "target_record", "verification", "model_usage", "duplicate", "change"] as const),
  at: s.string(),
  digest: s.string(),
  data: s.unknown(),
});

/** What Eve may do for one operation. No policy, no authority. */
export const policies = app.collection("policies", {
  operation: s.string(),
  /** Approval is a fact in the source system (a reaction by a named approver), never a claim in the request's text. */
  requiresApproval: s.boolean(),
  approvalReaction: s.string(),
  approvers: s.array(s.string()),
  /** Above this amount Eve does not act; it hands the request to a person. */
  maxAmount: s.number(),
  currency: s.string(),
  /** After an unknown outcome, Eve resends only once the destination shows the document is absent. */
  reconcileBeforeRetry: s.boolean(),
  maxAttempts: s.number(),
}, { unique: [["operation"]] });

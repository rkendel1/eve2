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
    source: ["tasks.submit", "tasks.advance", "tasks.read", "jobs.create"],
    // People who operate Eve: they set the policies that bound what it may do, assign work (a repository to assess,
    // an item to resolve; Eve's steps then run as the assigner), and read everything it did.
    operator: ["tasks.*", "policies.*", "jobs.create"],
  },
  dev: {
    users: [
      { id: "operator", name: "Operator", roles: ["operator"] },
      { id: "source-connector", name: "Source connector", type: "service", roles: ["source"] },
    ],
  },
  services: { jobs: { handlers: { "eve.advance": "tasks:advance" } } },
  requires: [
    { name: "reasoning.interpret", versions: "1", purpose: "turn a person's request into a structured intent" },
    { name: "reasoning.decide", versions: "1", optional: true, purpose: "choose the next action toward an objective from the actions offered" },
    ...["conversation.messages.get", "conversation.messages.reply"].map((name) => ({ name, versions: "1", optional: true, purpose: "read requests and answer where they were made" })),
    ...["finance.parties.find", "finance.accounts.find", "finance.documents.find", "finance.documents.create", "finance.documents.get"].map((name) => ({ name, versions: "1", optional: true, purpose: "record and verify documents in a ledger" })),
    ...["tracker.items.get", "tracker.items.find", "tracker.items.create", "tracker.items.comment"].map((name) => ({ name, versions: "1", optional: true, purpose: "read, file and answer work items" })),
    ...["code.workspace.open", "code.workspace.list", "code.workspace.read", "code.workspace.search", "code.workspace.write", "code.workspace.run", "code.workspace.result", "code.workspace.diff"].map((name) => ({ name, versions: "1", optional: true, purpose: "investigate and change a working copy, and run its declared checks" })),
    ...["code.changes.publish", "code.changes.get"].map((name) => ({ name, versions: "1", optional: true, purpose: "propose changes for review (never merge) and read them back" })),
  ],
});

/** Statuses a task moves through. Waiting statuses resume when the source delivers a change. */
export const STATUSES = [
  "received", "authorizing", "resolving", "ready", "reconciling", "verifying", "reporting",
  "opening", "preparing", "investigating", "proving", "filing", "implementing", "checking", "publishing",
  "needs_clarification", "needs_approval", "blocked",
  "completed", "verification_failed", "failed",
] as const;

/** The request Eve took responsibility for. */
export const tasks = app.collection("tasks", {
  sourceKey: s.string(),
  source: s.object({ system: s.string(), conversation: s.string(), message: s.string() }),
  /** record (a document into a ledger), assess (a repository, filing proven gaps), resolve (a work item, as a proposed change). */
  operation: s.optional(s.string()),
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
  /** The operation's working state: its workspace, decisions taken, a check it is waiting for. */
  work: s.optional(s.unknown()),
  /** What Eve reports when it is done: the artifacts it produced, with their verification. */
  report: s.optional(s.unknown()),
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
  kind: s.enum(["source_record", "approval", "target_record", "verification", "model_usage", "duplicate", "change", "decision", "observation", "finding", "check_result", "artifact"] as const),
  at: s.string(),
  digest: s.string(),
  data: s.unknown(),
});

/** What Eve may do for one operation. No policy, no authority. */
export const policies = app.collection("policies", {
  operation: s.string(),
  /** Approval is a fact in the source system (a reaction by a named approver), never a claim in the request's text. */
  requiresApproval: s.boolean(),
  approvalReaction: s.optional(s.string()),
  approvers: s.optional(s.array(s.string())),
  /** Above this amount Eve does not act; it hands the request to a person. */
  maxAmount: s.optional(s.number()),
  currency: s.optional(s.string()),
  /** After an unknown outcome, Eve resends only once the destination shows the effect is absent. */
  reconcileBeforeRetry: s.boolean(),
  maxAttempts: s.number(),
  /** Operation-specific bounds: repositories, how many decisions, issues or changed files, which paths are off limits. */
  limits: s.optional(s.unknown()),
}, { unique: [["operation"]] });

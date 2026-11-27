import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { registerSessionLineStore } from "#execution/hosts.js";
import { prepareInitialEntry, type SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { runPreparedSession } from "#execution/session/program.js";
import { createUlid } from "#shared/ulid.js";
import { runInputOwnerKey } from "#channel/session-owner.js";
import { readParentLineage } from "#execution/eve-workflow-attributes.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { createTurnControl } from "#execution/session/turn-control.js";
import type { SessionBoot } from "#execution/session/program.js";
import { foldPublishedTail } from "#execution/publish-session-events.js";
import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { isSubagentAdapterState } from "#subagents/adapter-state.js";
import { decodeStoredSession, type StoredLaunch, type StoredSession } from "./session-store.js";
import {
  adoptAgentTasks,
  recoverAgentTasks,
  settledByFacts,
  type AgentTaskRecovery,
  type OpenAgentTask,
  type ReattachHost,
  type StoredChild,
} from "./reattach.js";

type SessionOwner = string | null | { readonly root: string };
const ownersByHost = new WeakMap<InProcessHost, Map<string, SessionOwner>>();

function sessionOwners(host: InProcessHost): Map<string, SessionOwner> {
  let owners = ownersByHost.get(host);
  if (owners === undefined) ownersByHost.set(host, (owners = new Map()));
  return owners;
}
import { createInProcessHost, type InProcessHost, type InProcessHostOptions } from "./host.js";
import type { WorkflowFunction } from "./runs.js";

export type InProcessRuntimeOptions = InProcessHostOptions;

export interface SessionRestoration {
  readonly restored: readonly string[];
  readonly refused: readonly { readonly sessionId: string; readonly reason: string }[];
}

export interface SessionRestoreScope {
  readonly continuationToken: string;
}

export interface InProcessRuntime extends Runtime {
  restore(scope?: SessionRestoreScope): Promise<SessionRestoration>;
  settled(sessionId: string): Promise<void>;
  holds(token: string): boolean;
  stepsRunning(sessionId: string): number;
  idle(): Promise<void>;
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
  ): Promise<{ readonly sessionId: string }>;
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  dispose(): Promise<void>;
}

export function createInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions = {},
): InProcessRuntime {
  const runtimes = new Map<string, InProcessRuntime>();
  const runtimeFor = (child: SessionRuntimeConfig): InProcessRuntime => {
    const key = JSON.stringify(child);
    let runtime = runtimes.get(key);
    if (runtime === undefined) runtimes.set(key, (runtime = runtimeOn(host, child)));
    return runtime;
  };
  const host = createInProcessHost(options, runtimeFor);
  return runtimeFor(config);
}

function runtimeOn(host: InProcessHost, config: SessionRuntimeConfig): InProcessRuntime {
  const { inboxes, lines, running } = host;
  const owners = sessionOwners(host);

  const startEntry = (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
    owner?: SessionOwner,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> =>
    host.working(() => bootEntry(entry, continuationToken, owner));
  const run = (
    sessionId: string,
    boot: SessionBoot,
    inbox: Parameters<typeof runPreparedSession>[1],
  ) => {
    const session = runPreparedSession(boot, inbox, host.sessionHost).then(
      async () => {
        await host.persistence?.ended(sessionId).catch(() => {});
      },
      () => undefined,
    );
    running.set(sessionId, session);
    void session.finally(() => running.delete(sessionId));
  };
  const bootEntry = async (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
    owner: SessionOwner | undefined,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> => {
    const sessionId = `session_${createUlid()}`;
    owners.set(sessionId, owner ?? null);
    const sessionWritable = lines.open(sessionId);
    host.onDispose(registerSessionLineStore(sessionId, lines));
    const boot = await bootInitialOwner(
      { ...entry, ownerDeploymentId: host.deploymentId },
      sessionId,
      {
        inboxTransport: inboxes.transportFor(sessionId),
        sessionWritable,
        timeouts: () => undefined,
        async settleContinuationConflict({ command, continuationToken: token }) {
          if (inboxes.holder(token) === undefined)
            throw new Error(`No session here holds continuation "${token}".`);
          await host.deliverCommand(token, command);
        },
      },
    );
    if (boot === undefined) {
      const holder = inboxes.holder(continuationToken ?? "");
      if (holder === undefined) throw new Error("The session's address is held elsewhere.");
      return { claimedContinuation: false, sessionId: holder };
    }
    if (owner !== undefined) {
      const { start } = boot.session;
      await host.persistence?.track(
        {
          capabilities: boot.session.capabilities,
          continuationToken:
            (boot.session.serializedContext["eve.continuationToken"] as string) || "",
          ownerKey: owner,
          retention: boot.session.retention,
          sessionId,
          sessionTimeoutMs: boot.session.sessionTimeoutMs,
        },
        {
          openTurn: start.kind === "turn" ? { delivery: start.input } : undefined,
          state: {
            admittedDeliveryKeys: boot.session.admittedDeliveryKeys,
            history: boot.session.history,
            serializedContext: boot.session.serializedContext,
            sessionState: boot.session.sessionState,
          },
        },
      );
      const adapter = boot.session.serializedContext[CHANNEL_CONTEXT_KEY_NAME] as
        | { readonly state?: unknown }
        | undefined;
      if (isSubagentAdapterState(adapter?.state)) {
        await host.persistence?.acknowledgeChild(
          adapter.state.parentSessionId,
          adapter.state.callId,
          sessionId,
        );
      }
    }
    run(sessionId, boot.session, boot.inbox);
    return { claimedContinuation: true, sessionId };
  };
  const restoreEntry = async (
    stored: StoredSession,
    children: readonly StoredChild[],
  ): Promise<AgentTaskRecovery> => {
    const migration = migrateSessionCheckpoint(stored.checkpoint);
    if (migration.kind !== "current") {
      throw new Error(
        migration.kind === "pre-v27"
          ? "its checkpoint predates this eve's host sessions"
          : migration.detail,
      );
    }
    const { sessionId } = stored;
    const encoder = new TextEncoder();
    const storedLines = await host.store!.readLines(sessionId);
    const waiting = stored.openTurn?.waiting;
    const recovery = recoverAgentTasks({
      children,
      launches: stored.launches ?? [],
      lines: storedLines,
      sessionId,
      sessionState: migration.checkpoint.sessionState,
      undispatched: new Set(waiting?.on === "calls" && waiting.dispatch ? waiting.callIds : []),
    });
    const settled = settledByFacts(migration.checkpoint.sessionState, storedLines);
    const checkpoint = {
      ...migration.checkpoint,
      sessionState: adoptAgentTasks(
        waiting === undefined ? settled : foldPublishedTail(settled, storedLines),
        [...recovery.reattach, ...recovery.unknown],
      ),
    };
    const restoredLines = storedLines.map((line) => encoder.encode(line));
    owners.set(sessionId, stored.ownerKey);
    const sessionWritable = lines.open(sessionId, restoredLines);
    host.onDispose(registerSessionLineStore(sessionId, lines));
    const inbox = createSessionInbox(inboxes.transportFor(sessionId));
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
    if (stored.continuationToken !== "") await inbox.claimSessionHook(stored.continuationToken);
    await host.persistence!.track(stored);
    if (stored.openTurn !== undefined && stored.openTurn.waiting === undefined) {
      host.retryFirstStep(sessionId);
    }
    run(
      sessionId,
      {
        admittedDeliveryKeys: checkpoint.admittedDeliveryKeys,
        anchor: { kind: "self" },
        caller: undefined,
        capabilities: checkpoint.capabilities,
        deploymentId: host.deploymentId,
        history: checkpoint.history,
        initialTurnControl: createTurnControl(),
        retention: checkpoint.retention,
        serializedContext: checkpoint.serializedContext,
        sessionId,
        sessionState: checkpoint.sessionState,
        sessionTimeoutMs: checkpoint.sessionTimeoutMs,
        sessionWritable,
        start:
          stored.openTurn === undefined
            ? { kind: "parked" }
            : {
                input: stored.openTurn.delivery,
                kind: "turn",
                step: stored.openTurn.step,
                waiting,
                dispatched: stored.openTurn.dispatched,
              },
      },
      inbox,
    );
    return recovery;
  };
  const reattachHost: ReattachHost = {
    readEvents: async (sessionId) => readSessionEventStream(sessionId),
    async cancelChildTurn(sessionId) {
      await host.deliverCommand(sessionCommandHookToken(sessionId), {
        deliveryId: `reattach-cancel:${sessionId}`,
        kind: "cancel",
      });
    },
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const prepared = await prepareInitialEntry(config, input);
      const { rootSessionId, sessionId: parentId } = readParentLineage(prepared.serializedContext);
      const started = await startEntry(
        prepared.entry,
        input.continuationToken,
        parentId === undefined
          ? (runInputOwnerKey(input) ?? null)
          : { root: rootSessionId ?? parentId },
      );
      const delivery = prepared.input.delivery;
      if (!started.claimedContinuation) {
        return {
          claimedContinuation: false,
          events: readSessionEventStream(started.sessionId),
          sessionId: started.sessionId,
          ...(delivery !== undefined && { deliveryId: delivery.deliveryId }),
        };
      }
      let events: ReadableStream | undefined;
      return {
        get events() {
          return (events ??= readSessionEventStream(started.sessionId));
        },
        sessionId: started.sessionId,
        ...(delivery !== undefined && { deliveryId: delivery.deliveryId }),
      };
    },

    startEntry: (entry) => startEntry(entry, undefined),

    async restore(scope) {
      const restored: string[] = [];
      const refused: { sessionId: string; reason: string }[] = [];
      if (host.store === undefined) return { refused, restored };
      const records = await host.store.readSessions();
      const decoded = new Map<string, StoredSession>();
      const refusals = new Map<string, string>();
      for (const { record, sessionId } of records) {
        try {
          const stored = decodeStoredSession(record);
          const migration =
            stored.checkpoint === undefined
              ? undefined
              : migrateSessionCheckpoint(stored.checkpoint);
          if (migration !== undefined && migration.kind !== "current") {
            throw new Error(
              migration.kind === "pre-v27"
                ? "its checkpoint predates this eve's host sessions"
                : migration.detail,
            );
          }
          decoded.set(sessionId, stored);
        } catch (error) {
          refusals.set(sessionId, error instanceof Error ? error.message : String(error));
        }
      }
      refuseDescendants(decoded, refusals);
      const children = [...decoded.values()].flatMap((stored) =>
        stored.checkpoint === undefined || refusals.has(stored.sessionId)
          ? []
          : [
              {
                serializedContext: stored.checkpoint.serializedContext,
                sessionId: stored.sessionId,
              },
            ],
      );
      const reattaching: OpenAgentTask[] = [];
      const relaunching: StoredLaunch[] = [];
      const unknown: OpenAgentTask[] = [];
      const restoreRecords = async (pick: (stored: StoredSession) => boolean) => {
        for (const { sessionId } of records) {
          if (
            restored.includes(sessionId) ||
            refused.some((entry) => entry.sessionId === sessionId)
          )
            continue;
          const stored = decoded.get(sessionId);
          const refusal = refusals.get(sessionId);
          if (stored !== undefined && !pick(stored)) continue;
          if (refusal !== undefined) {
            refused.push({ reason: refusal, sessionId });
            continue;
          }
          if (stored === undefined || stored.ended === true || stored.checkpoint === undefined)
            continue;
          try {
            const recovery = await host.working(() => restoreEntry(stored, children));
            reattaching.push(...recovery.reattach);
            relaunching.push(...recovery.relaunch);
            unknown.push(...recovery.unknown);
            restored.push(sessionId);
          } catch (error) {
            refused.push({
              reason: error instanceof Error ? error.message : String(error),
              sessionId,
            });
          }
        }
      };
      await restoreRecords(
        (stored) => scope === undefined || stored.continuationToken === scope.continuationToken,
      );
      if (scope !== undefined) {
        await restoreRecords((stored) => {
          const owner = stored.ownerKey;
          return owner !== null && typeof owner === "object" && restored.includes(owner.root);
        });
      }
      for (const task of reattaching) host.runs.reattach(task, reattachHost);
      for (const launch of relaunching) host.runs.relaunch(launch);
      for (const task of unknown) host.runs.endUnknown(task);
      return { refused, restored };
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await host.deliverCommand(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await host.deliverCommand(sessionCommandHookToken(input.sessionId), input.command);
    },

    async resolveContinuation(continuationToken) {
      const sessionId = inboxes.holder(continuationToken);
      return sessionId === undefined ? undefined : { sessionId };
    },

    async getEventStream(sessionId, options) {
      return options?.follow === false
        ? readSessionEventHistory(sessionId, options.startIndex, options.signal)
        : readSessionEventStream(sessionId, options?.startIndex, options?.signal);
    },

    async getLineStream(sessionId, options) {
      return options?.follow === false
        ? readSessionRecordHistory(sessionId, options.startIndex)
        : readSessionRecords(sessionId, options?.startIndex);
    },

    async getStreamTailIndex(sessionId) {
      return await readSessionStreamTailIndex(sessionId);
    },

    async readSessionOwnerKey(sessionId) {
      const owner = owners.get(sessionId);
      if (owner === null || typeof owner !== "object") return owner;
      const root = owners.get(owner.root);
      return typeof root === "string" ? root : root === undefined ? undefined : null;
    },

    async settled(sessionId) {
      await running.get(sessionId);
    },

    holds: (token) => inboxes.holder(token) !== undefined,

    stepsRunning: (sessionId) => host.stepsRunning(sessionId),

    idle: () => host.idle(),

    registerWorkflow: (workflowId, workflowBody) =>
      host.runs.registerWorkflow(workflowId, workflowBody),

    dispose: () => host.dispose(),
  };
}

function refuseDescendants(
  decoded: ReadonlyMap<string, StoredSession>,
  refusals: Map<string, string>,
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const [sessionId, stored] of decoded) {
      if (refusals.has(sessionId)) continue;
      const blocked = [parentOf(stored), rootOf(stored)].find(
        (owner) => owner !== undefined && refusals.has(owner),
      );
      if (blocked === undefined) continue;
      refusals.set(
        sessionId,
        `its parent session ${blocked} could not be restored, so eve left this session stored and did not run it: ${refusals.get(blocked)}`,
      );
      grew = true;
    }
  }
}

function rootOf(stored: StoredSession): string | undefined {
  const owner = stored.ownerKey;
  return owner !== null && typeof owner === "object" ? owner.root : undefined;
}

function parentOf(stored: StoredSession): string | undefined {
  const adapter = stored.checkpoint?.serializedContext[CHANNEL_CONTEXT_KEY_NAME] as
    | { readonly state?: unknown }
    | undefined;
  return isSubagentAdapterState(adapter?.state) ? adapter.state.parentSessionId : undefined;
}

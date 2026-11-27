import type { LanguageModel } from "ai";

import type { Runtime } from "#channel/types.js";
import { createChannelAddress, namespacedContinuationToken } from "#channel/channel-address.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type SessionRestoration,
} from "#execution/in-process/runtime.js";
import type { DurableSessionStore } from "#execution/in-process/session-store.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { BundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  createRuntimeSession,
  setRuntimeSessionCompiledArtifacts,
  withRuntimeSession,
  type RuntimeSession,
} from "#runtime/sessions/runtime-session.js";

/** The compiled agent `eve build` produces: its manifest, module map and model metadata. */
export type EveCompiledAgent = BundledCompiledArtifacts;

/** A model reference as the agent declares it, for the host to resolve. */
export type EveModelReference = RuntimeModelReference;

/** How the host turns the agent's model references into models. The host makes every provider call and holds every credential. */
export interface EveHostModels {
  /** Returns the model a reference names. */
  resolve(reference: EveModelReference): Promise<LanguageModel> | LanguageModel;
}

/**
 * Where a host keeps its sessions so they survive the host: each session's event lines and one record per session.
 * Every write resolves only once it is durable; a record is opaque text eve reads back exactly as it wrote it.
 */
export interface EveHostStore extends DurableSessionStore {
  /** Appends line `index` (counting from 0) of a session's event stream. */
  appendLine(sessionId: string, index: number, line: string): Promise<void>;
  /** Every line of a session's event stream, in order. */
  readLines(sessionId: string): Promise<readonly string[]>;
  /** Replaces a session's record. */
  saveSession(sessionId: string, record: string): Promise<void>;
  /** Every session record the store holds. */
  readSessions(): Promise<readonly { readonly sessionId: string; readonly record: string }[]>;
}

/** What a host restored when it started: sessions back in service, and sessions it refused, with the reason. */
export type EveHostRestoration = SessionRestoration;

/**
 * Which stored sessions a host restores when it starts. `connection` restores only the session of that application
 * conversation: every other stored session stays as it was, and is neither resumed nor continued. A host started this
 * way serves only that conversation, so `connect` refuses any other.
 */
export interface EveHostRestoreScope {
  /** The application conversation this host restores and serves. */
  readonly connection: EveHostConnection;
}

/** What a host supplies to run an organization's agent. */
export interface EveHostOptions {
  /** The organization's agent, as `eve build` compiled it. One host runs one agent for every connection. */
  readonly agent: EveCompiledAgent;
  /** Model resolution. Without it, eve resolves the agent's own model definitions. */
  readonly models?: EveHostModels;
  /**
   * Durable session storage. With it, every session is restored when a host starts on the same store, at the turn
   * or wait it was in, and continues on the same application conversation. Without it, sessions end with the host.
   */
  readonly store?: EveHostStore;
  /**
   * Restores and serves one application conversation instead of every stored session. Use it when the host runs a
   * separate instance per conversation, so that starting an instance for one conversation never resumes another's
   * work. Without it, every stored session is restored.
   */
  readonly restore?: EveHostRestoreScope;
}

/** Where an application delivers work for one conversation: send messages, answer approvals, and read results. */
export type EveConversation = ReturnType<typeof createChannelAddress>;

/** One application's connection to the agent: a channel with its own conversations. It carries no authority. */
export interface EveHostConnection {
  /** The connecting application, used as the channel name. Each connection's conversations are kept apart from every other connection's. */
  readonly application: string;
  /** The conversation within that application, such as a meeting or an incident. */
  readonly conversation: string;
}

/** An organization's agent running on a host: eve's complete session runtime, with the host's infrastructure. */
export interface EveHost {
  /** eve's runtime contract: sessions, commands, and session streams. */
  readonly runtime: Runtime;
  /**
   * The address an application delivers work to. Each delivery names the person or service asking (`auth`). A host
   * started with a `restore` scope throws for any connection but its own.
   */
  connect(connection: EveHostConnection): EveConversation;
  /**
   * Resolves once the host has restored its stored sessions, or with a `restore` scope that conversation's session:
   * those it restored and those it refused. A refused session's record and lines are left as they were. With a scope,
   * a refused record whose conversation the host cannot read is listed too, since it may be the scoped conversation's.
   */
  readonly restoration: Promise<EveHostRestoration>;
  /** Resolves once no session has a step running or a delivery waiting to be handled. */
  idle(): Promise<void>;
  /** Stops every session the host started. */
  dispose(): Promise<void>;
}

/**
 * Runs an organization's agent with eve's complete session runtime: turns, tool calls, approvals, subagents, timeouts
 * and session completion are eve's. The host supplies the compiled agent and its infrastructure.
 *
 * Without a `store`, sessions live in this runtime while it runs and end with it. With one, they survive the host.
 */
export function createEveHost(options: EveHostOptions): EveHost {
  const session = createRuntimeSession("eve-host");
  let runtime!: InProcessRuntime;
  const ready = withRuntimeSession(session, () => {
    setRuntimeSessionCompiledArtifacts(session, options.agent);
    if (options.models !== undefined) {
      const models = options.models;
      session.hostModels = (reference) => models.resolve(reference);
    }
    runtime = createInProcessRuntime(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      options.store === undefined ? {} : { store: options.store },
    );
  });
  const scope = options.restore?.connection;
  const scopeToken = scope === undefined ? undefined : continuationTokenOf(scope);
  const restoration = ready.then(() =>
    withRuntimeSession(session, () =>
      runtime.restore(scopeToken === undefined ? undefined : { continuationToken: scopeToken }),
    ),
  );
  const restored = restoration.then(() => undefined);
  const within = inSession(session, restored);
  const hostedRuntime = within(runtime);
  return {
    runtime: hostedRuntime,
    connect: (connection) => {
      if (scopeToken !== undefined && continuationTokenOf(connection) !== scopeToken) {
        throw new Error(
          `This host restores and serves only ${scope!.application} conversation "${scope!.conversation}"; it cannot serve ${connection.application} conversation "${connection.conversation}".`,
        );
      }
      return within(
        createChannelAddress({
          adapter: { kind: "http" },
          channelName: connection.application,
          continuationToken: connection.conversation,
          runtime: hostedRuntime,
        }),
      );
    },
    restoration,
    idle: () => withRuntimeSession(session, () => runtime.idle()),
    dispose: () => withRuntimeSession(session, () => runtime.dispose()),
  };
}

function continuationTokenOf(connection: EveHostConnection): string {
  return namespacedContinuationToken(connection.application, connection.conversation);
}

function inSession(session: RuntimeSession, ready: Promise<void>) {
  return <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          withRuntimeSession(session, async () => {
            await ready;
            return await Reflect.apply(value, object, args);
          });
      },
    });
}

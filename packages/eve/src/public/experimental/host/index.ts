import type { LanguageModel } from "ai";

import type { Runtime } from "#channel/types.js";
import { createChannelAddress } from "#channel/channel-address.js";
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
  /** The address an application delivers work to. Each delivery names the person or service asking (`auth`). */
  connect(connection: EveHostConnection): EveConversation;
  /**
   * Resolves once the host has restored its stored sessions: those it restored and those it refused. A refused
   * session's record and lines are left as they were.
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
  const restoration = ready.then(() => withRuntimeSession(session, () => runtime.restore()));
  const restored = restoration.then(() => undefined);
  const within = inSession(session, restored);
  const hostedRuntime = within(runtime);
  return {
    runtime: hostedRuntime,
    connect: (connection) =>
      within(
        createChannelAddress({
          adapter: { kind: "http" },
          channelName: connection.application,
          continuationToken: connection.conversation,
          runtime: hostedRuntime,
        }),
      ),
    restoration,
    idle: () => withRuntimeSession(session, () => runtime.idle()),
    dispose: () => withRuntimeSession(session, () => runtime.dispose()),
  };
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

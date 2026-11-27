import "./prelude.js";
import { host, protocol, serve, sleep } from "./abg.js";
import { HostLanguageModel } from "./model.js";
import { GenerateLanguageModel } from "./generate-model.js";
import { createEveHost } from "eve/experimental/host";
import { ContextContainer, contextStorage } from "#context/container.js";
import { loadAgent } from "./agent.js";

const references = [];
const storeOn = (prefix) => ({
  appendLine: async (sessionId, index, line) =>
    void (await host(`${prefix}.appendLine`, { sessionId, index, line })),
  readLines: async (sessionId) => (await host(`${prefix}.readLines`, { sessionId })).lines,
  saveSession: async (sessionId, record) =>
    void (await host(`${prefix}.saveSession`, { sessionId, record })),
  readSessions: async () => (await host(`${prefix}.readSessions`, {})).sessions,
});
let started;
const eveFor = (durable, contract, scope) =>
  (started ??= loadAgent().then((agent) =>
    createEveHost({
      agent,
      ...(durable && { store: storeOn(protocol() === "appboundry" ? "sessions" : "store") }),
      ...(scope !== undefined && { restore: { connection: scope } }),
      models: {
        resolve: (reference) => {
          references.push(reference.id);
          return contract === "generate"
            ? new GenerateLanguageModel(reference.id, (request) => host("model.generate", request))
            : new HostLanguageModel(reference.id);
        },
      },
    }),
  ));

const summary = (result) => ({
  status: result.status,
  sessionId: result.sessionId,
  reply: result.reply ?? null,
  interactions: JSON.parse(JSON.stringify(result.interactions ?? [])),
  error: result.error ? String(result.error.message ?? result.error) : null,
});

const within = (promise, ms, what) =>
  Promise.race([
    promise,
    sleep(ms).then(() => Promise.reject(new Error(`${what} did not settle within ${ms} ms`))),
  ]);

async function sessionLines(eve, sessionId, limit = 60) {
  const lines = [];
  try {
    const reader = (await eve.runtime.getLineStream(sessionId)).getReader();
    while (lines.length < limit) {
      const next = await within(reader.read(), 200, "the session stream");
      if (next.done) break;
      lines.push(JSON.stringify(next.value).slice(0, 600));
    }
    reader.releaseLock();
  } catch (error) {
    lines.push(`(stream: ${String(error?.message ?? error)})`);
  }
  return lines;
}

async function deliver(request, act) {
  const connection = { application: request.application, conversation: request.conversation };
  const starting = started === undefined;
  const t0 = Date.now();
  const eve = await eveFor(
    request.durable === true,
    request.models,
    request.scoped ? connection : undefined,
  );
  const t1 = Date.now();
  let start;
  if (request.scoped) {
    const { refused, restored } = await eve.restoration;
    if (starting)
      start = { loadMs: t1 - t0, restoreMs: Date.now() - t1, restored: restored.length };
    if (refused.length > 0) {
      throw Object.assign(
        new Error(
          `${request.application} conversation "${request.conversation}" has a stored session this eve cannot restore (${refused.map((r) => `${r.sessionId}: ${r.reason}`).join("; ")}); its record is left as it was, and nothing is delivered.`,
        ),
        { code: "SESSION_UNRESTORABLE" },
      );
    }
  }
  const conversation = eve.connect(connection);
  const accepted = await act(conversation);
  try {
    const result = await within(
      accepted.result(),
      request.resultMs ?? 120_000,
      "the delivery's result",
    );
    await within(eve.idle(), request.idleMs ?? 120_000, "eve's idle");
    return { ...summary(result), modelReferences: references.splice(0), ...(start && { start }) };
  } catch (error) {
    const lines = await sessionLines(eve, accepted.sessionId);
    throw Object.assign(
      new Error(
        `${String(error?.message ?? error)}\nsession ${accepted.sessionId} lines:\n${lines.join("\n")}`,
      ),
      { stack: error?.stack },
    );
  }
}

const send = (request) =>
  deliver(request, (conversation) =>
    conversation.send(request.message, { auth: request.auth ?? null }),
  );
const answer = (request) =>
  deliver(request, (conversation) =>
    conversation.deliver({ answers: request.answers }, { auth: request.auth ?? null }),
  );

async function contextTests() {
  const a = new ContextContainer();
  const b = new ContextContainer();
  const tests = {};
  tests.asyncContextIsTheHosts = typeof globalThis.AsyncContext?.Variable === "function";
  tests.survivesAwait = await contextStorage.run(a, async () => {
    await Promise.resolve();
    await null;
    return contextStorage.getStore() === a;
  });
  tests.survivesHostRoundTrip = await contextStorage.run(a, async () => {
    await host("test.echo", { tag: "single" });
    return contextStorage.getStore() === a;
  });
  const work = (store, tag) =>
    contextStorage.run(store, async () => {
      const seen = [];
      for (let i = 0; i < 3; i++) {
        await host("test.echo", { tag, i });
        seen.push(
          contextStorage.getStore() === store
            ? tag
            : contextStorage.getStore() === undefined
              ? "none"
              : "other",
        );
      }
      return seen;
    });
  const [seenA, seenB] = await Promise.all([work(a, "a"), work(b, "b")]);
  tests.concurrentIsolation = {
    a: seenA,
    b: seenB,
    ok: seenA.every((x) => x === "a") && seenB.every((x) => x === "b"),
  };
  const c = new ContextContainer();
  const d = new ContextContainer();
  const [seenC, seenD] = await Promise.all([work(c, "c"), work(d, "d")]);
  tests.concurrentIsolationFirstFinishesFirst = {
    c: seenC,
    d: seenD,
    ok: seenC.every((x) => x === "c") && seenD.every((x) => x === "d"),
  };
  tests.nestedRunRestores = await contextStorage.run(a, async () => {
    const inner = await contextStorage.run(b, async () => {
      await host("test.echo", { tag: "inner" });
      return contextStorage.getStore() === b;
    });
    await host("test.echo", { tag: "outer" });
    return inner && contextStorage.getStore() === a;
  });
  tests.noLeakOutsideRun = await (async () => {
    await contextStorage.run(a, async () => host("test.echo", { tag: "leak" }));
    await host("test.echo", { tag: "after" });
    return contextStorage.getStore() === undefined;
  })();
  return { tests, ok: Object.values(tests).every((t) => t === true || t?.ok === true) };
}

function probe() {
  const g = globalThis;
  return {
    asyncHooks: typeof g.AsyncLocalStorage,
    fetchIsHostOperation: typeof g.fetch === "function",
    XMLHttpRequest: typeof g.XMLHttpRequest,
    WebSocket: typeof g.WebSocket,
    require: typeof g.require,
    processEnvKeys: Object.keys(g.process?.env ?? {}),
    suspiciousGlobals: Object.getOwnPropertyNames(g).filter((n) =>
      /key|secret|token|credential/i.test(n),
    ),
  };
}

async function fetchElsewhere(request) {
  try {
    const response = await fetch(request.url, { method: request.method ?? "GET" });
    return { refused: false, status: response.status };
  } catch (error) {
    return { refused: true, code: error.code ?? null, message: error.message };
  }
}

async function restore(request) {
  const eve = await eveFor(true);
  const restoration = await eve.restoration;
  await within(eve.idle(), request.idleMs ?? 120_000, "eve's idle after restoring");
  return { restoration, modelReferences: references.splice(0) };
}

const authOf = (principal) =>
  principal
    ? {
        attributes: { roles: [...(principal.roles ?? [])] },
        authenticator: `appboundry:${__EVE_APPLICATION__.id}`,
        issuer: "appboundry",
        principalId: principal.id,
        principalType: principal.type ?? "user",
      }
    : null;

function delivery(args, invocation) {
  for (const field of ["session", "application", "conversation"]) {
    if (typeof args[field] !== "string" || !args[field])
      throw Object.assign(new Error(`${field} is required`), { code: "INVALID_ARGUMENT" });
  }
  if (args.session !== `${args.application}.${args.conversation}`) {
    throw Object.assign(
      new Error(
        `session must be "${args.application}.${args.conversation}" (the application's conversation)`,
      ),
      { code: "INVALID_ARGUMENT" },
    );
  }
  return {
    application: args.application,
    conversation: args.conversation,
    auth: authOf(invocation.principal),
    durable: true,
    models: "generate",
    scoped: true,
  };
}

serve({
  application: __EVE_APPLICATION__,
  functions: {
    "eve:deliver": {
      kind: "action",
      handler: (args, invocation) =>
        send({ ...delivery(args, invocation), message: String(args.message ?? "") }),
    },
    "eve:answer": {
      kind: "action",
      handler: (args, invocation) =>
        answer({
          ...delivery(args, invocation),
          answers: Array.isArray(args.answers) ? args.answers : [],
        }),
    },
  },
  kinds: { send, answer, restore, context: contextTests, probe, fetch: fetchElsewhere },
});
const invoke = globalThis.__abg.invoke;
globalThis.__abg.invoke = (message) => {
  invoke(message);
  globalThis.__startDeferredTimers();
};

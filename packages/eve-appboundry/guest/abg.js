const pending = new Map();
const outbox = [];
let nextId = 1;
let invocation = null;
let state = null;

export const currentInvocation = () => invocation;
export const protocol = () => invocation?.protocol ?? null;

export function host(op, payload = {}) {
  if (invocation === null)
    return Promise.reject(new Error(`host operation ${op} outside an invocation`));
  const appboundry = invocation.protocol === "appboundry";
  const id = appboundry ? nextId++ : `${invocation.id}:${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, op });
    outbox.push(
      appboundry ? { id, op, ...payload } : { id, op, invocation: invocation.id, ...payload },
    );
  });
}

export const MAX_SLEEP_MS = 60_000;

const timers = new Map();
let nextTimer = 1;
let clock = null;

export function addTimer(ms, fire) {
  const id = nextTimer++;
  timers.set(id, {
    deadline: Date.now() + Math.max(0, Number(ms) || 0),
    fire: globalThis.AsyncContext ? globalThis.AsyncContext.Snapshot.wrap(fire) : fire,
  });
  return () => void timers.delete(id);
}

export const sleep = (ms) => new Promise((resolve) => addTimer(ms, resolve));

function fireDue() {
  const now = Date.now();
  for (const [id, timer] of [...timers].sort((a, b) => a[1].deadline - b[1].deadline)) {
    if (timer.deadline > now) break;
    timers.delete(id);
    timer.fire();
  }
}

const nearest = () => Math.min(...[...timers.values()].map((t) => t.deadline));

const LEVELS = { log: "info", info: "info", warn: "warn", error: "error" };
const structuredLogs = (lines) =>
  lines.map((line) => {
    const space = line.indexOf(" ");
    return { level: LEVELS[line.slice(0, space)] ?? "info", message: line.slice(space + 1) };
  });

export function serve({ application, functions = {}, kinds = {} }) {
  globalThis.__abg = {
    describe: () =>
      JSON.stringify({
        ok: true,
        abi: "appboundry-guest/1",
        producer: application.producer,
        application: application.id,
        functions: Object.entries(functions).map(([name, fn]) => ({ name, kind: fn.kind })),
        migrations: [],
      }),
    invoke(message) {
      const request = JSON.parse(message);
      if (invocation !== null) throw new Error("one invocation at a time");
      const appboundry = typeof request.function === "string";
      invocation = appboundry
        ? { id: String(request.requestId ?? ""), protocol: "appboundry", request }
        : { id: String(request.id), protocol: "harness", kind: request.kind };
      state = null;
      Promise.resolve()
        .then(() => {
          if (appboundry) {
            const fn = functions[request.function];
            if (!fn)
              throw Object.assign(
                new Error(`${request.function} is not a function of this program`),
                { code: "FUNCTION_NOT_FOUND" },
              );
            return fn.handler(request.args ?? {}, request);
          }
          const handler = kinds[request.kind];
          if (!handler) throw new Error(`unknown invocation kind ${request.kind}`);
          return handler(request);
        })
        .then(
          (value) => (state = { state: "returned", value: value === undefined ? null : value }),
          (error) =>
            (state = {
              state: "failed",
              error: {
                code: error?.code ?? "INTERNAL",
                message: String(error?.message ?? error),
                ...(appboundry ? {} : { stack: String(error?.stack ?? "") }),
              },
            }),
        );
    },
    resume(message) {
      for (const answer of JSON.parse(message)) {
        if (clock !== null && answer.id === clock.id) {
          clock = null;
          continue;
        }
        const waiting = pending.get(answer.id);
        if (!waiting)
          throw new Error(
            `host answered ${answer.id}, which no pending request of this invocation asked`,
          );
        pending.delete(answer.id);
        if (answer.ok) waiting.resolve(answer.value);
        else
          waiting.reject(
            Object.assign(new Error(answer.error?.message ?? "host operation failed"), {
              code: answer.error?.code,
              op: waiting.op,
            }),
          );
      }
      fireDue();
    },
    poll() {
      const lines = globalThis.__logs.splice(0);
      if (state !== null) {
        const appboundry = invocation.protocol === "appboundry";
        outbox.length = 0;
        const done = appboundry
          ? { ...state, logs: structuredLogs(lines) }
          : { ...state, abandoned: [...pending.keys()], logs: lines };
        pending.clear();
        timers.clear();
        clock = null;
        invocation = null;
        return JSON.stringify(done);
      }
      globalThis.__logs.unshift(...lines);
      const calls = outbox.splice(0);
      if (
        calls.length === 0 &&
        pending.size === 0 &&
        timers.size > 0 &&
        (clock === null || nearest() < clock.until)
      ) {
        const ms = Math.min(MAX_SLEEP_MS, Math.max(0, Math.ceil(nearest() - Date.now())));
        clock = {
          id: invocation.protocol === "appboundry" ? nextId++ : `${invocation.id}:${nextId++}`,
          until: Date.now() + ms,
        };
        calls.push(
          invocation.protocol === "appboundry"
            ? { id: clock.id, op: "timer.sleep", ms }
            : { id: clock.id, op: "timer.sleep", invocation: invocation.id, ms },
        );
      }
      return JSON.stringify({ state: "suspended", calls, logs: [] });
    },
  };
}

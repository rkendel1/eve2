import "./async-context.js";
import { host } from "./abg.js";
import { structuredClone as clone } from "./structured-clone.js";
import { Buffer } from "buffer/index.js";
import {
  ReadableStream,
  WritableStream,
  TransformStream,
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
} from "web-streams-polyfill";

const g = globalThis;
g.global ??= g;
g.process ??= {
  env: {},
  platform: "appboundry",
  versions: {},
  version: "v0.0.0-appboundry",
  cwd: () => "/",
  nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)),
};
g.Buffer ??= Buffer;
Object.assign(g, {
  ReadableStream,
  WritableStream,
  TransformStream,
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
});
g.queueMicrotask ??= (fn) => void Promise.resolve().then(fn);

import { addTimer, currentInvocation, protocol } from "./abg.js";
let timerId = 0;
const cleared = new Set();
const deferred = [];
const cancels = new Map();
const start = (id, ms, fn, args) =>
  cancels.set(
    id,
    addTimer(ms, () => {
      cancels.delete(id);
      if (!cleared.delete(id)) fn(...args);
    }),
  );
g.__startDeferredTimers = () => {
  for (const timer of deferred.splice(0)) start(...timer);
};
const schedule = (fn, ms, args) => {
  const id = ++timerId;
  const delay = Math.max(0, Number(ms) || 0);
  if (currentInvocation() === null) deferred.push([id, delay, fn, args]);
  else start(id, delay, fn, args);
  return id;
};
g.setTimeout ??= (fn, ms = 0, ...args) => schedule(fn, ms, args);
const clear = (id) => {
  cleared.add(id);
  cancels.get(id)?.();
  cancels.delete(id);
};
g.clearTimeout ??= clear;
g.setImmediate ??= (fn, ...args) => schedule(fn, 0, args);
g.clearImmediate ??= clear;
g.setInterval ??= () => {
  throw new Error("setInterval is not available in the guest");
};
g.structuredClone ??= clone;
g.__abgConstShape = (target, value) => {
  const get = () => value;
  get.raw = value;
  return Object.defineProperty(target, "shape", { get, configurable: true, enumerable: true });
};
const logs = (g.__logs = []);
const say =
  (level) =>
  (...a) =>
    logs.length < 200 &&
    logs.push(
      `${level} ${a
        .map((x) =>
          typeof x === "string"
            ? x
            : (() => {
                try {
                  return JSON.stringify(x);
                } catch {
                  return String(x);
                }
              })(),
        )
        .join(" ")}`.slice(0, 2000),
    );
g.console ??= {
  log: say("log"),
  info: say("info"),
  warn: say("warn"),
  error: say("error"),
  debug() {},
  trace() {},
};
class TE {
  get encoding() {
    return "utf-8";
  }
  encode(input = "") {
    const s = String(input);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < s.length &&
        (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00
      )
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    return Uint8Array.from(out);
  }
  encodeInto(input, dest) {
    const b = this.encode(input);
    dest.set(b.subarray(0, dest.length));
    return { read: String(input).length, written: Math.min(b.length, dest.length) };
  }
}
class TD {
  constructor(label = "utf-8") {
    if (!/^utf-?8$/i.test(label))
      throw new RangeError(`TextDecoder ${label} is not supported in the guest`);
  }
  get encoding() {
    return "utf-8";
  }
  decode(input) {
    if (input === undefined) return "";
    const b =
      input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
    let s = "";
    for (let i = 0; i < b.length;) {
      const x = b[i];
      let c = 0xfffd,
        n = 1;
      if (x < 0x80) c = x;
      else if (x >= 0xc2 && x < 0xe0 && (b[i + 1] & 0xc0) === 0x80) {
        c = ((x & 31) << 6) | (b[i + 1] & 63);
        n = 2;
      } else if (
        x >= 0xe0 &&
        x < 0xf0 &&
        (b[i + 1] & 0xc0) === 0x80 &&
        (b[i + 2] & 0xc0) === 0x80
      ) {
        c = ((x & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
        n = 3;
        if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) c = 0xfffd;
      } else if (
        x >= 0xf0 &&
        x < 0xf5 &&
        (b[i + 1] & 0xc0) === 0x80 &&
        (b[i + 2] & 0xc0) === 0x80 &&
        (b[i + 3] & 0xc0) === 0x80
      ) {
        c = ((x & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
        n = 4;
        if (c < 0x10000 || c > 0x10ffff) c = 0xfffd;
      }
      s +=
        c > 0xffff
          ? String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 1023))
          : String.fromCharCode(c);
      i += n;
    }
    return s;
  }
}
g.TextEncoder ??= TE;
g.TextDecoder ??= TD;
class USP {
  constructor(q = "") {
    this._p = [];
    for (const kv of String(q).replace(/^\?/, "").split("&").filter(Boolean)) {
      const [k, v = ""] = kv.split("=");
      this._p.push([decodeURIComponent(k), decodeURIComponent(v)]);
    }
  }
  get(k) {
    const e = this._p.find((p) => p[0] === k);
    return e ? e[1] : null;
  }
  set(k, v) {
    this._p = this._p.filter((p) => p[0] !== k);
    this._p.push([k, String(v)]);
  }
  append(k, v) {
    this._p.push([k, String(v)]);
  }
  has(k) {
    return this._p.some((p) => p[0] === k);
  }
  toString() {
    return this._p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }
  [Symbol.iterator]() {
    return this._p[Symbol.iterator]();
  }
}
class U {
  constructor(input, base) {
    const s = String(input);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
    if (!m) {
      if (base !== undefined) {
        const b = new U(base);
        return new U(b.origin + (s.startsWith("/") ? s : b.pathname.replace(/[^/]*$/, "") + s));
      }
      throw new TypeError("Invalid URL: " + s);
    }
    this.protocol = m[1];
    this.host = m[2] ?? "";
    this.hostname = this.host.replace(/:\d+$/, "");
    this.port = (/:(\d+)$/.exec(this.host) || [])[1] ?? "";
    this.pathname = m[3] || (m[2] !== undefined ? "/" : "");
    this.search = m[4] ?? "";
    this.hash = m[5] ?? "";
    this.searchParams = new USP(this.search);
  }
  get origin() {
    return `${this.protocol}//${this.host}`;
  }
  get href() {
    const q = this.searchParams.toString();
    return `${this.protocol}${this.host || this.protocol === "file:" ? "//" + this.host : ""}${this.pathname}${q ? "?" + q : ""}${this.hash}`;
  }
  toString() {
    return this.href;
  }
  toJSON() {
    return this.href;
  }
  static canParse(i, b) {
    try {
      new U(i, b);
      return true;
    } catch {
      return false;
    }
  }
}
globalThis.URL ??= U;
globalThis.URLSearchParams ??= USP;
class H {
  constructor(init) {
    this._m = new Map();
    if (init)
      for (const [k, v] of init instanceof H
        ? init.entries()
        : Array.isArray(init)
          ? init
          : Object.entries(init))
        this.set(k, v);
  }
  get(k) {
    return this._m.get(String(k).toLowerCase()) ?? null;
  }
  set(k, v) {
    this._m.set(String(k).toLowerCase(), String(v));
  }
  append(k, v) {
    const c = this.get(k);
    this.set(k, c === null ? v : c + ", " + v);
  }
  has(k) {
    return this._m.has(String(k).toLowerCase());
  }
  delete(k) {
    this._m.delete(String(k).toLowerCase());
  }
  entries() {
    return this._m.entries();
  }
  keys() {
    return this._m.keys();
  }
  values() {
    return this._m.values();
  }
  forEach(f) {
    for (const [k, v] of this._m) f(v, k, this);
  }
  [Symbol.iterator]() {
    return this._m.entries();
  }
}
globalThis.Headers ??= H;

import guestCrypto from "./node/crypto.cjs";
g.crypto ??= {
  randomUUID: guestCrypto.randomUUID,
  getRandomValues: guestCrypto.getRandomValues,
  get subtle() {
    throw new Error("crypto.subtle is not available in the AppBoundry guest");
  },
};

class DOMExceptionImpl extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
  get code() {
    return { AbortError: 20, TimeoutError: 23 }[this.name] ?? 0;
  }
}
g.DOMException ??= DOMExceptionImpl;
class EventImpl {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.timeStamp = Date.now();
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {}
  stopImmediatePropagation() {
    this._stop = true;
  }
}
class EventTargetImpl {
  #listeners = new Map();
  addEventListener(type, listener, options) {
    if (!listener) return;
    const once = typeof options === "object" && !!options?.once;
    const list = this.#listeners.get(type) ?? [];
    if (!list.some((l) => l.listener === listener)) list.push({ listener, once });
    this.#listeners.set(type, list);
    options?.signal?.addEventListener?.("abort", () => this.removeEventListener(type, listener), {
      once: true,
    });
  }
  removeEventListener(type, listener) {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter((l) => l.listener !== listener),
    );
  }
  dispatchEvent(event) {
    event.target = event.currentTarget = this;
    for (const entry of [...(this.#listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      if (typeof entry.listener === "function") entry.listener.call(this, event);
      else entry.listener.handleEvent(event);
      if (event._stop) break;
    }
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
    return !event.defaultPrevented;
  }
}
g.Event ??= EventImpl;
g.EventTarget ??= EventTargetImpl;
class AbortSignalImpl extends EventTargetImpl {
  constructor() {
    super();
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }
  _abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason =
      reason === undefined
        ? new DOMExceptionImpl("This operation was aborted", "AbortError")
        : reason;
    this.dispatchEvent(new EventImpl("abort"));
  }
  static abort(reason) {
    const s = new AbortSignalImpl();
    s._abort(reason);
    return s;
  }
  static timeout(ms) {
    const s = new AbortSignalImpl();
    g.setTimeout(
      () => s._abort(new DOMExceptionImpl("The operation timed out.", "TimeoutError")),
      ms,
    );
    return s;
  }
  static any(signals) {
    const s = new AbortSignalImpl();
    for (const signal of signals) {
      if (signal.aborted) {
        s._abort(signal.reason);
        return s;
      }
    }
    for (const signal of signals)
      signal.addEventListener("abort", () => s._abort(signal.reason), { once: true });
    return s;
  }
}
class AbortControllerImpl {
  constructor() {
    this.signal = new AbortSignalImpl();
  }
  abort(reason) {
    this.signal._abort(reason);
  }
}
g.AbortSignal ??= AbortSignalImpl;
g.AbortController ??= AbortControllerImpl;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
g.btoa ??= (input) => {
  const s = String(input);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i),
      b = s.charCodeAt(i + 1),
      c = s.charCodeAt(i + 2);
    if (a > 255 || b > 255 || c > 255)
      throw new DOMExceptionImpl("Invalid character", "InvalidCharacterError");
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < s.length ? B64[n & 63] : "=");
  }
  return out;
};
g.atob ??= (input) => {
  const s = String(input)
    .replace(/[\t\n\f\r ]/g, "")
    .replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1)
    throw new DOMExceptionImpl("Invalid character", "InvalidCharacterError");
  let out = "";
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64.indexOf(s[i]) << 18) |
      (B64.indexOf(s[i + 1]) << 12) |
      ((B64.indexOf(s[i + 2]) & 63) << 6) |
      (B64.indexOf(s[i + 3]) & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < s.length) out += String.fromCharCode(n & 255);
  }
  return out;
};
const origin = Date.now();
g.performance ??= { timeOrigin: origin, now: () => Date.now() - origin, mark() {}, measure() {} };
g.TextEncoderStream ??= class extends TransformStream {
  constructor() {
    const e = new g.TextEncoder();
    super({ transform: (chunk, c) => c.enqueue(e.encode(chunk)) });
  }
};
g.TextDecoderStream ??= class extends TransformStream {
  constructor() {
    const d = new g.TextDecoder();
    super({ transform: (chunk, c) => c.enqueue(d.decode(chunk)) });
  }
};
class ResponseImpl {
  constructor(body = "", init = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.headers = new g.Headers(init.headers ?? {});
    this.ok = this.status >= 200 && this.status < 300;
    this.url = init.url ?? "";
    this.bodyUsed = false;
    this._body = String(body ?? "");
  }
  async text() {
    if (this.bodyUsed) throw new TypeError("Body has already been consumed.");
    this.bodyUsed = true;
    return this._body;
  }
  async json() {
    return JSON.parse(await this.text());
  }
}
g.Response ??= ResponseImpl;
const CAPABILITY_ENDPOINT = "https://capabilities.invalid/invoke";
async function viaCapabilityInvoke(url, method, body) {
  if (url !== CAPABILITY_ENDPOINT || method !== "POST")
    throw new TypeError(
      `${method} ${url}: an AppBoundry guest reaches other systems only through its capability endpoint`,
    );
  const { capability, input, idempotencyKey } = JSON.parse(body ?? "{}");
  if (typeof idempotencyKey !== "string" || !idempotencyKey)
    return {
      ok: false,
      error: {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "A capability call needs the tool call's idempotency key.",
      },
    };
  const outcome = await host("capability.invoke", { name: capability, input, idempotencyKey });
  if (outcome.outcome === "succeeded") return { ok: true, value: outcome.value };
  if (outcome.outcome === "unknown")
    return {
      ok: false,
      error: {
        code: "OUTCOME_UNKNOWN",
        message: `${capability} was sent but no answer came back: it may or may not have taken effect. Check before calling it again.`,
      },
    };
  return {
    ok: false,
    error: {
      code: outcome.error?.code ?? "CAPABILITY_FAILED",
      message: String(outcome.error?.message ?? outcome.outcome),
    },
  };
}
g.fetch ??= async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const headers = Object.fromEntries(new g.Headers(init.headers ?? {}).entries());
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string")
    throw new TypeError("the guest's fetch sends text bodies only");
  const method = String(init.method ?? "GET").toUpperCase();
  if (protocol() === "appboundry")
    return new ResponseImpl(JSON.stringify(await viaCapabilityInvoke(url, method, init.body)), {
      status: 200,
      headers: { "content-type": "application/json" },
      url,
    });
  const answer = await host("net.fetch", { url, method, headers, body: init.body ?? null });
  return new ResponseImpl(answer.body, { status: answer.status, headers: answer.headers, url });
};
for (const name of ["Blob", "File", "FormData", "Request"]) {
  g[name] ??= class {
    constructor() {
      throw new Error(
        `${name} is not available in the AppBoundry guest (no files; use a host operation)`,
      );
    }
  };
}

let current = new Map();
const nativeThen = Promise.prototype.then;
const bind = (fn, snapshot) =>
  typeof fn !== "function"
    ? fn
    : function (value) {
        const previous = current;
        current = snapshot;
        try {
          return fn.call(this, value);
        } finally {
          current = previous;
        }
      };
Object.defineProperty(Promise.prototype, "then", {
  configurable: true,
  writable: true,
  value: function then(onFulfilled, onRejected) {
    const snapshot = current;
    return nativeThen.call(this, bind(onFulfilled, snapshot), bind(onRejected, snapshot));
  },
});

class Variable {
  get() {
    return current.get(this);
  }
  run(value, fn, ...args) {
    const previous = current;
    current = new Map(previous).set(this, value);
    try {
      return fn(...args);
    } finally {
      current = previous;
    }
  }
}

class Snapshot {
  #snapshot = current;
  run(fn, ...args) {
    return bind(() => fn(...args), this.#snapshot)();
  }
  static wrap(fn) {
    return bind(fn, current);
  }
}

Object.defineProperty(globalThis, "AsyncContext", {
  value: Object.freeze({ Variable, Snapshot }),
  configurable: false,
  writable: false,
});

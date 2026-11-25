interface AsyncContextVariable<T> {
  get(): T | undefined;
  run<R, A extends unknown[]>(value: T, fn: (...args: A) => R, ...args: A): R;
}

interface AsyncContextNamespace {
  Variable: new <T>() => AsyncContextVariable<T>;
}

function asyncContext(): AsyncContextNamespace {
  const namespace = (globalThis as { AsyncContext?: AsyncContextNamespace }).AsyncContext;
  if (namespace === undefined) {
    throw new Error(
      "eve needs an async context to keep each session's state apart. On Node it uses AsyncLocalStorage; this host provides neither AsyncLocalStorage nor globalThis.AsyncContext. Install an AsyncContext implementation that propagates through every promise continuation before loading eve.",
    );
  }
  return namespace;
}

export class AsyncLocalStorage<T> {
  readonly #variable: AsyncContextVariable<T> = new (asyncContext().Variable)<T>();

  getStore(): T | undefined {
    return this.#variable.get();
  }

  run<R, A extends unknown[]>(store: T, fn: (...args: A) => R, ...args: A): R {
    return this.#variable.run(store, fn, ...args);
  }
}

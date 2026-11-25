export function delay<T>(
  ms: number,
  value?: T,
  options?: { readonly signal?: AbortSignal | null },
): Promise<T> {
  const signal = options?.signal ?? undefined;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value as T);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (ArrayBuffer.isView(a)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const view = b as ArrayBufferView;
    const right = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  if (a instanceof Map || a instanceof Set) {
    throw new Error(
      "isDeepStrictEqual compares JSON-shaped values outside Node; Map and Set need node:util.",
    );
  }
  const keysA = Reflect.ownKeys(a).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(a, key),
  );
  const keysB = Reflect.ownKeys(b).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(b, key),
  );
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      isDeepStrictEqual(
        (a as Record<PropertyKey, unknown>)[key],
        (b as Record<PropertyKey, unknown>)[key],
      ),
  );
}

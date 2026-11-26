export function inspect(
  value: unknown,
  options?: { readonly depth?: number; readonly maxStringLength?: number },
): string {
  const limit = options?.maxStringLength ?? Number.POSITIVE_INFINITY;
  const seen = new WeakSet<object>();
  const describe = (item: unknown, depth: number): unknown => {
    if (typeof item === "string")
      return item.length > limit
        ? `${item.slice(0, limit)}… ${item.length - limit} more characters`
        : item;
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (depth > (options?.depth ?? 2)) return Array.isArray(item) ? "[Array]" : "[Object]";
    if (item instanceof Error) {
      const described: Record<string, unknown> = {
        name: item.name,
        message: describe(item.message, depth + 1),
        stack: describe(item.stack, depth + 1),
      };
      if (item.cause !== undefined) described.cause = describe(item.cause, depth + 1);
      Object.assign(described, describe({ ...item }, depth + 1));
      return described;
    }
    if (Array.isArray(item)) return item.map((entry) => describe(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [key, describe(entry, depth + 1)]),
    );
  };
  try {
    return JSON.stringify(describe(value, 0)) ?? String(value);
  } catch {
    return String(value);
  }
}

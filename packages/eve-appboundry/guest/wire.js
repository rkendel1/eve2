export const encode = (value) =>
  JSON.stringify(value, function (key, v) {
    const raw = this[key];
    if (raw instanceof Uint8Array) return { $bytes: Array.from(raw) };
    if (raw instanceof Date) return { $date: raw.toISOString() };
    if (typeof URL !== "undefined" && raw instanceof URL) return { $url: raw.href };
    return v;
  });
export const decode = (text) =>
  JSON.parse(text, (_key, v) => {
    if (v && typeof v === "object") {
      if (Array.isArray(v.$bytes)) return Uint8Array.from(v.$bytes);
      if (typeof v.$date === "string") return new Date(v.$date);
      if (typeof v.$url === "string") return new URL(v.$url);
    }
    return v;
  });

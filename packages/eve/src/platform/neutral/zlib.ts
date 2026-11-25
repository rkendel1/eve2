export const zlibConstants = { Z_SYNC_FLUSH: 2 } as const;

export function inflateSync(
  _buffer: Uint8Array,
  _options?: { readonly finishFlush?: number },
): Uint8Array {
  throw new Error(
    "Reading compressed document metadata needs zlib, which this host does not provide to eve.",
  );
}

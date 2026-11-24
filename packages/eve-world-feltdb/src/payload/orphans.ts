import type { PayloadStore, StoredPayload } from "./types.js";

/**
 * Indexed payloads that no authoritative record references and that were
 * written at least `graceMs` ago. The grace covers a writer between `write`
 * and the commit that references the payload; that commit carries the
 * payload's guard, so it fails rather than referencing a payload removed in
 * the meantime.
 */
export async function findOrphanedPayloads(
  store: PayloadStore,
  isReferenced: (digest: string) => boolean | Promise<boolean>,
  options: { graceMs: number; now?: number },
): Promise<StoredPayload[]> {
  const cutoff = (options.now ?? Date.now()) - options.graceMs;
  const orphans: StoredPayload[] = [];
  for await (const entry of store.list()) {
    if (entry.writtenAt > cutoff) continue;
    if (!(await isReferenced(entry.ref.digest))) orphans.push(entry);
  }
  return orphans;
}

/*!
 * Adapted from @workflow/world-local 5.4.1, packages/world-local/src/queue-auth-key.ts
 * (https://github.com/vercel/workflow). Copyright 2025 Vercel Inc. Licensed under
 * the Apache License, Version 2.0. Modified for eve's FeltDB World; see UPSTREAM.md.
 */
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  generateQueueAuthKey,
  globalSingleton,
  isWellFormedQueueAuthKey,
  setQueueAuthKeySource,
} from "@workflow/utils";
import { ensureDataDir } from "./package-info.js";
export const QUEUE_AUTH_KEY_FILE = "queue-auth-key";
export type QueueAuthKeyMode = "regenerate" | "read";
const RELOAD_INTERVAL_MS = 250;
interface KeyFileState {
  key: string | undefined;
  regenerated: Promise<void> | undefined;
  writer: boolean;
  reloading: Promise<string | undefined> | undefined;
  lastReloadAt: number;
  loggedWriteFailure: boolean;
}
const keyFiles = () =>
  globalSingleton("@workflow/world-local//queueAuthKeyFiles", 1, () => ({
    byDir: new Map<string, KeyFileState>(),
  }));
function stateFor(dir: string): KeyFileState {
  const { byDir } = keyFiles();
  let state = byDir.get(dir);
  if (!state) {
    state = {
      key: undefined,
      regenerated: undefined,
      writer: false,
      reloading: undefined,
      lastReloadAt: Number.NEGATIVE_INFINITY,
      loggedWriteFailure: false,
    };
    byDir.set(dir, state);
  }
  return state;
}
export async function readQueueAuthKeyFile(dir: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path.join(dir, QUEUE_AUTH_KEY_FILE), "utf8")).trim();
    return isWellFormedQueueAuthKey(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
async function writeQueueAuthKeyFile(dir: string, key: string): Promise<void> {
  await ensureDataDir(dir);
  const tmp = path.join(
    dir,
    `.${QUEUE_AUTH_KEY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, `${key}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path.join(dir, QUEUE_AUTH_KEY_FILE));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
function logWriteFailure(state: KeyFileState, dir: string, error: unknown) {
  if (state.loggedWriteFailure) return;
  state.loggedWriteFailure = true;
  console.error(
    `[world-local] Could not write the queue auth key to ${path.join(dir, QUEUE_AUTH_KEY_FILE)}; ` +
      "this app's own deliveries still authenticate, but the CLI, the web UI and " +
      "other processes of the app cannot until it can be written.",
    { error: String(error) },
  );
}
export interface QueueAuthKey {
  current(): Promise<string | undefined>;
  reload(): Promise<string | undefined>;
  restore(): Promise<void>;
  written(): Promise<void>;
}
export function createQueueAuthKey(dataDir: string, mode: QueueAuthKeyMode): QueueAuthKey {
  const dir = path.resolve(dataDir);
  const state = stateFor(dir);
  const reload = (): Promise<string | undefined> => {
    if (state.reloading) return state.reloading;
    const promise = (async () => {
      if (state.regenerated) await state.regenerated;
      const fromFile = await readQueueAuthKeyFile(dir);
      if (fromFile) {
        state.key = fromFile;
      } else if (state.writer && state.key) {
        await writeQueueAuthKeyFile(dir, state.key).catch((error) =>
          logWriteFailure(state, dir, error),
        );
      }
      return state.key;
    })().finally(() => {
      state.reloading = undefined;
    });
    state.reloading = promise;
    return promise;
  };
  if (mode === "regenerate" && !state.regenerated) {
    state.writer = true;
    state.key = generateQueueAuthKey();
    const key = state.key;
    state.regenerated = writeQueueAuthKeyFile(dir, key).catch((error) =>
      logWriteFailure(state, dir, error),
    );
    setQueueAuthKeySource(dir, {
      current: () => state.key,
      reload: async () => {
        const now = Date.now();
        if (!state.reloading && now - state.lastReloadAt < RELOAD_INTERVAL_MS) {
          return state.key;
        }
        state.lastReloadAt = now;
        return reload();
      },
    });
  }
  return {
    async current() {
      if (state.regenerated) await state.regenerated;
      if (state.key === undefined && !state.writer) return reload();
      return state.key;
    },
    reload,
    async restore() {
      if (!state.writer || !state.key) return;
      await writeQueueAuthKeyFile(dir, state.key).catch((error) =>
        logWriteFailure(state, dir, error),
      );
    },
    async written() {
      if (state.regenerated) await state.regenerated;
    },
  };
}

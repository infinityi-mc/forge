/**
 * Durable JSON-file preference store.
 *
 * Saves use a same-directory temporary file followed by `rename`, so readers
 * never observe a half-written preferences file. File watching is opt-in
 * because not every deployment wants filesystem observers open by default.
 *
 * @module
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  PreferenceSnapshot,
  PreferenceSnapshotHandler,
  PreferenceStore,
} from "./types";
import { cloneStoreSnapshot } from "./store-snapshot";

export interface JsonFileStoreOptions {
  /** JSON file path used for persistence. */
  readonly path: string;
  /** Store name surfaced in diagnostics. Defaults to `"json-file"`. */
  readonly name?: string;
  /** Delay writes by this many milliseconds. Defaults to immediate writes. */
  readonly debounceMs?: number;
  /** Observe external file changes and emit snapshots through `watch`. */
  readonly watch?: boolean;
  /** Debounce external reload events. Defaults to 25ms. */
  readonly watchDebounceMs?: number;
}

export type JsonFilePreferenceStore = PreferenceStore;

export function jsonFileStore(
  options: JsonFileStoreOptions,
): JsonFilePreferenceStore {
  const filePath = options.path;
  const name = options.name ?? "json-file";
  const debounceMs = Math.max(0, options.debounceMs ?? 0);
  const watchDebounceMs = Math.max(0, options.watchDebounceMs ?? 25);
  const handlers = new Set<PreferenceSnapshotHandler>();
  let pendingSnapshot: PreferenceSnapshot | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  let writeError: unknown;
  let lastExternalJson: string | undefined;
  let localWritesInFlight = 0;
  let reloadSkippedDuringLocalWrite = false;
  let shutDown = false;

  const readSnapshot = async (): Promise<PreferenceSnapshot | undefined> => {
    const file = Bun.file(filePath, { type: "application/json" });
    if (!(await file.exists())) return undefined;

    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      if (isNotFoundError(cause)) return undefined;
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      const corruptPath = await quarantineCorruptFile(filePath);
      throw new CorruptPreferenceFileError(
        `Corrupt preference file '${filePath}' was moved aside to '${corruptPath}'.`,
        { cause },
      );
    }

    if (!isPlainRecord(parsed)) {
      const corruptPath = await quarantineCorruptFile(filePath);
      throw new CorruptPreferenceFileError(
        `Preference file '${filePath}' must contain a JSON object; moved aside to '${corruptPath}'.`,
      );
    }

    return cloneStoreSnapshot(parsed);
  };

  const enqueueWrite = (snapshot: PreferenceSnapshot): Promise<void> => {
    const run = writeTail.then(async () => {
      localWritesInFlight += 1;
      try {
        await atomicWriteSnapshot(filePath, snapshot);
        lastExternalJson = snapshotJson(snapshot);
        writeError = undefined;
      } finally {
        localWritesInFlight -= 1;
        if (localWritesInFlight === 0 && reloadSkippedDuringLocalWrite) {
          reloadSkippedDuringLocalWrite = false;
          scheduleReload();
        }
      }
    });
    writeTail = run.catch((cause) => {
      writeError = cause;
    });
    return run;
  };

  const flushPending = async (): Promise<void> => {
    while (true) {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }

      const snapshot = pendingSnapshot;
      if (snapshot !== undefined) {
        pendingSnapshot = undefined;
        try {
          await enqueueWrite(snapshot);
        } catch (cause) {
          writeError = undefined;
          throw cause;
        }
        continue;
      }

      await writeTail;
      if (writeError !== undefined) {
        const cause = writeError;
        writeError = undefined;
        throw cause;
      }
      if (saveTimer === undefined && pendingSnapshot === undefined) return;
    }
  };

  const scheduleSave = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const snapshot = pendingSnapshot;
      if (snapshot === undefined) return;
      pendingSnapshot = undefined;
      void enqueueWrite(snapshot).catch(() => {});
    }, debounceMs);
  };

  const reloadExternal = async (): Promise<void> => {
    if (shutDown) return;
    if (localWritesInFlight > 0) {
      reloadSkippedDuringLocalWrite = true;
      return;
    }
    let snapshot: PreferenceSnapshot | undefined;
    let diagnostic: Parameters<PreferenceSnapshotHandler>[1];
    try {
      snapshot = await readSnapshot();
    } catch (cause) {
      if (!(cause instanceof CorruptPreferenceFileError)) return;
      diagnostic = {
        status: "store_error",
        store: name,
        reason: cause.message,
      };
      snapshot = {};
    }

    const next = snapshot ?? {};
    const nextJson = JSON.stringify(next);
    if (nextJson === lastExternalJson) return;
    lastExternalJson = nextJson;

    for (const handler of [...handlers]) {
      try {
        handler(cloneStoreSnapshot(next), diagnostic);
      } catch {
        // Store watchers are isolated so one bad consumer does not block others.
      }
    }
  };

  const scheduleReload = (): void => {
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      void reloadExternal();
    }, watchDebounceMs);
  };

  const startWatcher = (): void => {
    if (watcher !== undefined) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const target = basename(filePath);
    watcher = watch(dirname(filePath), (_event, filename) => {
      if (!isRelevantWatchEvent(filename, target)) return;
      scheduleReload();
    });
    watcher.on("error", () => {
      stopWatcher();
    });
  };

  const stopWatcher = (): void => {
    if (reloadTimer !== undefined) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
    watcher?.close();
    watcher = undefined;
  };

  const store: JsonFilePreferenceStore = {
    name,
    async load(): Promise<PreferenceSnapshot | undefined> {
      assertOpen(name, shutDown, "load");
      return readSnapshot();
    },
    async save(snapshot): Promise<void> {
      assertOpen(name, shutDown, "save");
      pendingSnapshot = cloneStoreSnapshot(snapshot);
      if (debounceMs > 0) {
        scheduleSave();
        return;
      }
      await flushPending();
    },
    async flush(): Promise<void> {
      if (shutDown) return;
      await flushPending();
    },
    async shutdown(): Promise<void> {
      if (shutDown) return;
      handlers.clear();
      stopWatcher();

      let error: unknown;
      try {
        await flushPending();
      } catch (cause) {
        error = cause;
      }
      shutDown = true;
      if (error !== undefined) throw error;
    },
  };

  if (options.watch === true) {
    store.watch = (handler): (() => void) => {
      if (shutDown) return () => {};
      handlers.add(handler);
      startWatcher();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers.delete(handler);
        if (handlers.size === 0) stopWatcher();
      };
    };
  }

  return store;
}

async function atomicWriteSnapshot(
  filePath: string,
  snapshot: PreferenceSnapshot,
): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const encoded = `${JSON.stringify(snapshot, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  try {
    await Bun.write(temporaryPath, encoded, { mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => {});
    await fsyncFileBestEffort(temporaryPath);
    await rename(temporaryPath, filePath);
    await fsyncFileBestEffort(directory);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw cause;
  }
}

async function quarantineCorruptFile(filePath: string): Promise<string> {
  const corruptPath = await nextCorruptPath(filePath);
  try {
    await rename(filePath, corruptPath);
  } catch (cause) {
    if (!isNotFoundError(cause)) throw cause;
  }
  return corruptPath;
}

async function nextCorruptPath(filePath: string): Promise<string> {
  const first = `${filePath}.corrupt`;
  if (!(await Bun.file(first).exists())) return first;
  return `${filePath}.${Date.now()}.${crypto.randomUUID()}.corrupt`;
}

async function fsyncFileBestEffort(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some platforms; atomic rename still holds.
  }
}

function assertOpen(name: string, shutDown: boolean, phase: string): void {
  if (!shutDown) return;
  throw new Error(`Preference store '${name}' has been shut down during ${phase}.`);
}

class CorruptPreferenceFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptPreferenceFileError";
  }
}

function snapshotJson(snapshot: PreferenceSnapshot): string {
  return JSON.stringify(snapshot);
}

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function isRelevantWatchEvent(
  filename: string | Buffer | null,
  target: string,
): boolean {
  if (filename === null) return true;
  const changed = String(filename);
  return (
    changed === target ||
    (changed.startsWith(`${target}.`) && changed.endsWith(".tmp"))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * In-memory preference store for tests and local-only usage.
 *
 * @module
 */

import type { PreferenceSnapshot, PreferenceStore } from "./types";

export interface MemoryStoreOptions {
  readonly name?: string;
}

export interface MemoryPreferenceStore extends PreferenceStore {
  snapshot(): PreferenceSnapshot;
  replace(snapshot: PreferenceSnapshot): void;
}

export function memoryStore(
  initial?: PreferenceSnapshot,
  options: MemoryStoreOptions = {},
): MemoryPreferenceStore {
  let current = initial === undefined ? undefined : cloneSnapshot(initial);
  let shutDown = false;
  const handlers = new Set<(snapshot: PreferenceSnapshot) => void>();
  const name = options.name ?? "memory";

  return {
    name,
    async load(): Promise<PreferenceSnapshot | undefined> {
      return current === undefined ? undefined : cloneSnapshot(current);
    },
    async save(snapshot: PreferenceSnapshot): Promise<void> {
      current = cloneSnapshot(snapshot);
    },
    watch(handler): () => void {
      if (shutDown) return () => {};
      handlers.add(handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers.delete(handler);
      };
    },
    async flush(): Promise<void> {},
    async shutdown(): Promise<void> {
      shutDown = true;
      handlers.clear();
    },
    snapshot(): PreferenceSnapshot {
      return current === undefined ? {} : cloneSnapshot(current);
    },
    replace(snapshot: PreferenceSnapshot): void {
      current = cloneSnapshot(snapshot);
      if (shutDown) return;
      for (const handler of [...handlers]) {
        try {
          handler(cloneSnapshot(current));
        } catch {
          // Store watchers are isolated so one bad consumer does not block others.
        }
      }
    },
  };
}

function cloneSnapshot(snapshot: PreferenceSnapshot): PreferenceSnapshot {
  return structuredClone(snapshot) as PreferenceSnapshot;
}

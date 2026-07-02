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
  initial: PreferenceSnapshot = {},
  options: MemoryStoreOptions = {},
): MemoryPreferenceStore {
  let current = cloneSnapshot(initial);
  const name = options.name ?? "memory";

  return {
    name,
    async load(): Promise<PreferenceSnapshot> {
      return cloneSnapshot(current);
    },
    async save(snapshot: PreferenceSnapshot): Promise<void> {
      current = cloneSnapshot(snapshot);
    },
    snapshot(): PreferenceSnapshot {
      return cloneSnapshot(current);
    },
    replace(snapshot: PreferenceSnapshot): void {
      current = cloneSnapshot(snapshot);
    },
  };
}

function cloneSnapshot(snapshot: PreferenceSnapshot): PreferenceSnapshot {
  return structuredClone(snapshot) as PreferenceSnapshot;
}

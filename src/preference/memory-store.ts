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
  let current = { ...initial };
  const name = options.name ?? "memory";

  return {
    name,
    async load(): Promise<PreferenceSnapshot> {
      return { ...current };
    },
    async save(snapshot: PreferenceSnapshot): Promise<void> {
      current = { ...snapshot };
    },
    snapshot(): PreferenceSnapshot {
      return { ...current };
    },
    replace(snapshot: PreferenceSnapshot): void {
      current = { ...snapshot };
    },
  };
}

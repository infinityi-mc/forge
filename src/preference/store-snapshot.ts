import type { PreferenceSnapshot } from "./types";

export function cloneStoreSnapshot(
  snapshot: PreferenceSnapshot,
): PreferenceSnapshot {
  const cloned = structuredClone(snapshot) as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(cloned).sort()) {
    setSnapshotValue(sorted, key, cloned[key]);
  }
  return sorted;
}

export function setSnapshotValue(
  snapshot: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(snapshot, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

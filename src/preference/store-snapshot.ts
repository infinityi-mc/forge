import type { PreferenceSnapshot } from "./types";

export function cloneStoreSnapshot(
  snapshot: PreferenceSnapshot,
): PreferenceSnapshot {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(snapshot).sort()) {
    setSnapshotValue(sorted, key, structuredClone(snapshot[key]));
  }
  return sorted;
}

export function tryCloneStoreSnapshotValue(value: unknown):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: message };
  }
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

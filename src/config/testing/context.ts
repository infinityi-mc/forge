/**
 * Async override context used by `forge/config/testing`.
 *
 * `defineConfig` returns frozen accessor objects that read through
 * this context before falling back to the validated base snapshot.
 * Keeping the state in AsyncLocalStorage makes overrides safe for
 * parallel tests and nested mocks.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { installConfigOverrideReader } from "../overrides";

type UnknownRecord = Record<string, unknown>;

const overrideStorage = new AsyncLocalStorage<readonly UnknownRecord[]>();

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

installConfigOverrideReader(getOverride);

export function runWithConfigOverride<T>(
  overrides: UnknownRecord,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const current = overrideStorage.getStore() ?? [];
  return overrideStorage.run([...current, overrides], fn);
}

function getOverride(path: readonly string[]): { found: true; value: unknown } | { found: false } {
  const stack = overrideStorage.getStore();
  if (stack === undefined) return { found: false };

  for (let i = stack.length - 1; i >= 0; i--) {
    const hit = getAtPathIfOwn(stack[i]!, path);
    if (hit.found) return hit;
  }

  return { found: false };
}

function getAtPathIfOwn(
  root: UnknownRecord,
  path: readonly string[],
): { found: true; value: unknown } | { found: false } {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Async override context used by `forge/preference/testing`.
 *
 * Overrides are scoped to an async call chain so parallel tests can read the
 * same preference handle with different mocked values without mutating stores.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { installPreferenceOverrideReader } from "../overrides";

type UnknownRecord = Record<string, unknown>;

const overrideStorage = new AsyncLocalStorage<readonly UnknownRecord[]>();

type AtomicObject = Date | RegExp | URL | Map<unknown, unknown> | Set<unknown>;

export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends AtomicObject
      ? T
      : T extends object
        ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
        : T;

installPreferenceOverrideReader({
  read: getOverride,
  has: hasOverride,
});

export function runWithPreferenceOverride<T>(
  overrides: UnknownRecord,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const current = overrideStorage.getStore() ?? [];
  const normalized = cloneOverride(overrides) as UnknownRecord;
  return overrideStorage.run([...current, normalized], fn);
}

function cloneOverride(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneOverride(item)));
  }
  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneOverride(child);
  }
  return Object.freeze(out);
}

function getOverride(
  path: readonly string[],
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  const stack = overrideStorage.getStore();
  if (stack === undefined) return { found: false };

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const hit = getAtPathIfOwn(stack[i]!, path);
    if (hit.found) return hit;
  }

  return { found: false };
}

function hasOverride(path: readonly string[]): boolean {
  const stack = overrideStorage.getStore();
  if (stack === undefined) return false;

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (getAtPathIfOwn(stack[i]!, path).found) return true;
  }

  return false;
}

function getAtPathIfOwn(
  root: UnknownRecord,
  path: readonly string[],
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
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

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

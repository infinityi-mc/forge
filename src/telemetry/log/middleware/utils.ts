/**
 * Internal helpers shared by built-in log middleware.
 *
 * @module
 */

import type { LogAttributes, LogRecord } from "../types";

/**
 * Produce a new `LogRecord` with `attributes` swapped. All other fields
 * (level, message, timestamp, context) are copied by reference.
 */
export function cloneRecord(
  record: LogRecord,
  attributes: LogAttributes,
): LogRecord {
  return { ...record, attributes };
}

/**
 * Read a dotted path out of a nested object, returning `undefined` for
 * any missing segment. `"a.b.c"` walks `{ a: { b: { c: 1 } } }`.
 */
export function getPath(root: unknown, path: string): unknown {
  const parts = normalizePath(path);
  if (parts.length === 0) return undefined;
  let cur = root;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Return a structurally-cloned copy of `root` with `path` set to
 * `value`. Intermediate objects/arrays are shallow-cloned to preserve
 * immutability of the input.
 */
export function setPathClone(
  root: LogAttributes,
  path: string,
  value: unknown,
): LogAttributes {
  const parts = normalizePath(path);
  if (parts.length === 0) return root;
  const out: LogAttributes = { ...root };
  let target: Record<string, unknown> = out;
  let source: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const sourceValue =
      typeof source === "object" && source !== null
        ? (source as Record<string, unknown>)[key]
        : undefined;
    const next =
      typeof sourceValue === "object" && sourceValue !== null
        ? Array.isArray(sourceValue)
          ? [...sourceValue]
          : { ...(sourceValue as Record<string, unknown>) }
        : {};
    target[key] = next;
    target = next as Record<string, unknown>;
    source = sourceValue;
  }
  target[parts[parts.length - 1]!] = value;
  return out;
}

function normalizePath(path: string): string[] {
  return path.split(".").filter(Boolean);
}

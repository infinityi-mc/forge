/**
 * Eagerly serialize `Error` values inside `attributes` to plain objects
 * so transport-level `JSON.stringify` produces useful output (Errors
 * have non-enumerable `name`, `message`, `stack` and would otherwise
 * serialize as `"{}"`).
 *
 * @module
 */

import { serializeError } from "../serialize";
import type { LogAttributes, LogMiddleware } from "../types";
import { cloneRecord, getPath, setPathClone } from "./utils";

export interface SerializeOptions {
  /** Specific attribute paths to serialize. Defaults to recursively
   *  serializing every nested `Error` in the attribute tree. */
  errorKeys?: readonly string[];
}

export function serialize(options: SerializeOptions = {}): LogMiddleware {
  const errorKeys = options.errorKeys;
  return (next) => ({
    export(record) {
      const attributes = errorKeys
        ? serializeOnly(record.attributes, errorKeys)
        : (serializeAll(record.attributes) as LogAttributes);
      next.export(cloneRecord(record, attributes));
    },
  });
}

function serializeOnly(
  attributes: LogAttributes,
  errorKeys: readonly string[],
): LogAttributes {
  let out = attributes;
  for (const path of errorKeys) {
    const value = getPath(out, path);
    if (value instanceof Error) {
      out = setPathClone(out, path, serializeError(value));
    }
  }
  return out;
}

function serializeAll(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(serializeAll(item, seen));
    return out;
  }
  const out: LogAttributes = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = serializeAll((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

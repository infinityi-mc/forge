/**
 * PII redaction middleware. Removes sensitive values from log records
 * before any downstream exporter sees them.
 *
 * @module
 */

import type { LogAttributes, LogMiddleware } from "../types";
import { cloneRecord, getPath, setPathClone } from "./utils";

export interface RedactOptions {
  /**
   * Dotted attribute paths to wholesale replace. e.g. `"user.password"`
   * sets the `password` field to the replacement string.
   */
  paths?: readonly string[];
  /**
   * Regular expressions applied to every string value in `attributes`
   * and to the record's `message`. Matched substrings are replaced.
   */
  patterns?: readonly RegExp[];
  /** Replacement string. Defaults to `"[REDACTED]"`. */
  replacement?: string;
}

export function redact(options: RedactOptions = {}): LogMiddleware {
  const paths = [...(options.paths ?? [])];
  const patterns = [...(options.patterns ?? [])];
  const replacement = options.replacement ?? "[REDACTED]";

  return (next) => ({
    export(record) {
      let attributes = redactPatterns(
        record.attributes,
        patterns,
        replacement,
      ) as LogAttributes;
      for (const path of paths) {
        if (getPath(attributes, path) !== undefined) {
          attributes = setPathClone(attributes, path, replacement);
        }
      }
      next.export({
        ...cloneRecord(record, attributes),
        message: redactString(record.message, patterns, replacement),
      });
    },
  });
}

function redactPatterns(
  value: unknown,
  patterns: readonly RegExp[],
  replacement: string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") {
    return redactString(value, patterns, replacement);
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  if (value instanceof Date || value instanceof Error) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(redactPatterns(item, patterns, replacement, seen));
    }
    return out;
  }
  const out: LogAttributes = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = redactPatterns(
      (value as Record<string, unknown>)[key],
      patterns,
      replacement,
      seen,
    );
  }
  return out;
}

function redactString(
  value: string,
  patterns: readonly RegExp[],
  replacement: string,
): string {
  let out = value;
  for (const pattern of patterns) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * JSON-line formatter for `stdoutExporter`. Produces the structured
 * shape backends expect: one log record per newline-terminated JSON
 * object, with trace ids hoisted to top-level keys so log
 * aggregators can index them without parsing nested objects.
 *
 * @module
 */

import type { LogRecord } from "../../types";

export interface JsonFormatOptions {
  /** Override the field name for the message. Defaults to `"msg"`. */
  messageKey?: string;
  /** Override the field name for the level. Defaults to `"level"`. */
  levelKey?: string;
  /** Override the field name for the timestamp. Defaults to `"time"`. */
  timestampKey?: string;
  /**
   * How to render the timestamp. Defaults to `"iso"` (ISO-8601 string).
   * `"epoch"` writes Unix epoch milliseconds as a number.
   */
  timestampFormat?: "iso" | "epoch";
  /** Include `trace_id`/`span_id` as top-level keys when context is present. Defaults to `true`. */
  includeTraceIds?: boolean;
  /** Include the full baggage map under `baggage`. Defaults to `false` (use the `correlation` middleware to hoist specific keys). */
  includeBaggage?: boolean;
}

const DEFAULTS: Required<JsonFormatOptions> = {
  messageKey: "msg",
  levelKey: "level",
  timestampKey: "time",
  timestampFormat: "iso",
  includeTraceIds: true,
  includeBaggage: false,
};

/**
 * Serialize a single record to a newline-terminated JSON string.
 *
 * `attributes` are spread onto the top-level object so consumers writing
 * `log.info("served", { method: "GET" })` see `method` as a top-level
 * key, not nested under `attributes.method`.
 */
export function formatJson(
  record: LogRecord,
  options: JsonFormatOptions = {},
): string {
  const opts = { ...DEFAULTS, ...options };
  const payload: Record<string, unknown> = {};

  payload[opts.timestampKey] =
    opts.timestampFormat === "epoch"
      ? record.timestamp.getTime()
      : record.timestamp.toISOString();
  payload[opts.levelKey] = record.level;
  payload[opts.messageKey] = record.message;

  if (record.context !== undefined) {
    if (opts.includeTraceIds) {
      payload["trace_id"] = record.context.traceId;
      payload["span_id"] = record.context.spanId;
      if (record.context.parentId !== undefined) {
        payload["parent_id"] = record.context.parentId;
      }
    }
    if (opts.includeBaggage && Object.keys(record.context.baggage).length > 0) {
      payload["baggage"] = record.context.baggage;
    }
  }

  for (const key of Object.keys(record.attributes)) {
    if (key in payload) continue; // Per-record attrs MUST NOT overwrite framing keys.
    payload[key] = record.attributes[key];
  }

  return `${safeStringify(payload)}\n`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Handle the three common reasons the fast path fails: BigInt
    // values, circular references, and the rest (e.g. a throwing
    // `toJSON`). We coerce BigInt to string and break cycles, then
    // fall through to a placeholder if that still fails — because
    // returning *something* is more important than the exact shape.
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(value, (_key, val) => {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
    } catch {
      // Last-resort placeholder. Hit when an attribute has a throwing
      // `toJSON` — `toJSON` runs before the replacer per spec, so we
      // can't intercept it.
      return '{"_serialization_error":true}';
    }
  }
}

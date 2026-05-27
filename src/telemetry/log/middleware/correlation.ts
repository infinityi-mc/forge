/**
 * Pull baggage from the active {@link TelemetryContext} into log
 * attributes so it survives exporter serialization.
 *
 * The logger already attaches the {@link TelemetryContext} object to
 * every record (see `log/log.ts`), but some exporters only serialize
 * the `attributes` field. `correlation()` copies selected baggage keys
 * (or all keys, by default) onto `attributes` so they're guaranteed to
 * appear in the wire payload.
 *
 * @module
 */

import type { TelemetryContext } from "../../context/types";
import type { LogAttributes, LogMiddleware } from "../types";
import { cloneRecord } from "./utils";

export interface CorrelationOptions {
  /** Baggage keys to copy. Defaults to all keys from the active context. */
  keys?: readonly string[];
  /**
   * Read context from a custom source. Defaults to the record's own
   * `context` field (set by the logger from `AsyncLocalStorage`).
   */
  source?: (record: { context?: TelemetryContext }) => TelemetryContext | undefined;
  /**
   * Also copy `traceId`/`spanId` onto attributes. Defaults to `true`
   * so legacy log backends that don't know about OTLP still get the
   * correlation ids.
   */
  includeTraceIds?: boolean;
}

export function correlation(options: CorrelationOptions = {}): LogMiddleware {
  const source = options.source ?? defaultSource;
  const keys = options.keys;
  const includeTraceIds = options.includeTraceIds ?? true;

  return (next) => ({
    export(record) {
      const ctx = source(record);
      if (!ctx) {
        next.export(record);
        return;
      }
      const additions: LogAttributes = {};
      const baggageKeys = keys ?? Object.keys(ctx.baggage);
      for (const key of baggageKeys) {
        if (
          record.attributes[key] === undefined &&
          ctx.baggage[key] !== undefined
        ) {
          additions[key] = ctx.baggage[key];
        }
      }
      if (includeTraceIds) {
        if (record.attributes["trace_id"] === undefined) {
          additions["trace_id"] = ctx.traceId;
        }
        if (record.attributes["span_id"] === undefined) {
          additions["span_id"] = ctx.spanId;
        }
      }
      if (Object.keys(additions).length === 0) {
        next.export(record);
        return;
      }
      next.export(cloneRecord(record, { ...additions, ...record.attributes }));
    },
  });
}

function defaultSource(record: {
  context?: TelemetryContext;
}): TelemetryContext | undefined {
  return record.context;
}

/**
 * OTLP/HTTP JSON exporter for `forge/telemetry/log`.
 *
 * The `LogExporter` contract requires a synchronous `export()` so the
 * exporter buffers records in memory and flushes them in batches:
 *
 * - `export()` enqueues the record. If the queue reaches
 *   `maxQueueSize` the oldest record is dropped (logged to stderr).
 *   If the queue reaches `maxBatchSize` the exporter schedules a
 *   background flush.
 * - `flush()` drains the queue into a single OTLP request.
 * - `shutdown()` runs a final flush.
 *
 * @module
 */

import type { LogExporter, LogRecord } from "../../log/types";
import type { Resource } from "../../types";
import {
  encodeAttributes,
  encodeResource,
  kv,
  toNanos,
  type KeyValue,
} from "./encoding";
import {
  createOtlpHttpClient,
  type OtlpHttpClientOptions,
} from "./transport";

export interface OtlpHttpLogExporterOptions
  extends Omit<OtlpHttpClientOptions, "url"> {
  /** Collector URL. Defaults to `http://localhost:4318/v1/logs`. */
  url?: string;
  /** Resource attached to every record. */
  resource: Resource;
  /**
   * Maximum number of records retained in the queue. Records arriving
   * after the limit cause the oldest record to be dropped (one stderr
   * line per drop event). Defaults to `2048`.
   */
  maxQueueSize?: number;
  /**
   * Trigger a background flush once the queue grows to this size. The
   * batch is then sent in one OTLP request. Defaults to `512`.
   */
  maxBatchSize?: number;
  /**
   * Surface exporter failures by throwing from `flush()` / `shutdown()`.
   * When `false` (default), failures are written to stderr as a JSON
   * line so they don't propagate into host code.
   */
  propagateExporterErrors?: boolean;
}

const SEVERITY_NUMBER: Readonly<Record<string, number>> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

export function otlpHttpLogExporter(
  options: OtlpHttpLogExporterOptions,
): LogExporter {
  const {
    resource,
    url = "http://localhost:4318/v1/logs",
    maxQueueSize = 2048,
    maxBatchSize = 512,
    propagateExporterErrors = false,
    ...clientOpts
  } = options;
  const send = createOtlpHttpClient({ url, ...clientOpts });

  const queue: LogRecord[] = [];
  let pendingFlush: Promise<void> | undefined;
  let shuttingDown = false;

  async function flushOnce(signal?: AbortSignal): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    const body = JSON.stringify(buildBody(resource, batch));
    try {
      await send(body, signal);
    } catch (err) {
      if (propagateExporterErrors) throw err;
      reportError(err);
    }
  }

  function scheduleBackgroundFlush(): void {
    if (pendingFlush) return;
    pendingFlush = Promise.resolve()
      .then(() => flushOnce())
      .catch((err) => reportError(err))
      .finally(() => {
        pendingFlush = undefined;
        if (queue.length >= maxBatchSize && !shuttingDown) {
          scheduleBackgroundFlush();
        }
      });
  }

  return {
    export(record: LogRecord): void {
      if (shuttingDown) return;
      if (queue.length >= maxQueueSize) {
        queue.shift();
        reportError(
          new Error(
            `otlpHttpLogExporter: queue full at ${maxQueueSize}; dropping oldest record`,
          ),
        );
      }
      queue.push(record);
      if (queue.length >= maxBatchSize) scheduleBackgroundFlush();
    },
    async flush(opts) {
      if (pendingFlush) await pendingFlush;
      await flushOnce(opts?.signal);
    },
    async shutdown() {
      shuttingDown = true;
      if (pendingFlush) await pendingFlush;
      await flushOnce();
    },
  };
}

function reportError(err: unknown): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        _telemetry_exporter_error: true,
        exporter: "otlp-http-log",
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  } catch {
    // last-resort: swallow
  }
}

function buildBody(resource: Resource, records: readonly LogRecord[]) {
  return {
    resourceLogs: [
      {
        resource: encodeResource(resource),
        scopeLogs: [
          {
            scope: { name: "forge/telemetry/log" },
            logRecords: records.map(toOtlpLogRecord),
          },
        ],
      },
    ],
  };
}

function toOtlpLogRecord(record: LogRecord) {
  const attributes: KeyValue[] = encodeAttributes(record.attributes);
  if (record.context) {
    attributes.push(kv("baggage.json", JSON.stringify(record.context.baggage)));
  }
  return {
    timeUnixNano: toNanos(record.timestamp),
    severityNumber: SEVERITY_NUMBER[record.level] ?? 0,
    severityText: record.level.toUpperCase(),
    body: { stringValue: record.message },
    attributes,
    ...(record.context
      ? {
          traceId: record.context.traceId,
          spanId: record.context.spanId,
          flags: record.context.traceFlags,
        }
      : {}),
  };
}

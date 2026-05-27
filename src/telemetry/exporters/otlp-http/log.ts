/**
 * OTLP/HTTP JSON exporter for `forge/telemetry/log`.
 *
 * Encodes records into the OTLP `ExportLogsServiceRequest` shape and
 * POSTs them to the configured collector. Records are grouped by
 * resource so a single batch produces a single request.
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
  const { resource, url = "http://localhost:4318/v1/logs", ...clientOpts } =
    options;
  const send = createOtlpHttpClient({ url, ...clientOpts });

  return {
    async export(record: LogRecord): Promise<void> {
      const body = JSON.stringify(buildBody(resource, [record]));
      await send(body);
    },
    async flush() {},
    async shutdown() {},
  };
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

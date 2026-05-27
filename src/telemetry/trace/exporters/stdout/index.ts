/**
 * Stdout span exporter — writes each batch as a single JSON object per
 * line to `process.stdout`. Good for development; not recommended for
 * production tracing volumes.
 *
 * @module
 */

import type { ReadableSpan, SpanExporter } from "../../types";

export interface StdoutSpanExporterOptions {
  stdout?: { write(chunk: string): unknown };
}

export function stdoutSpanExporter(
  options: StdoutSpanExporterOptions = {},
): SpanExporter {
  const out = options.stdout ?? process.stdout;
  return {
    export(batch) {
      for (const span of batch) {
        out.write(`${JSON.stringify(serializeSpan(span))}\n`);
      }
    },
  };
}

function serializeSpan(span: ReadableSpan): Record<string, unknown> {
  return {
    name: span.name,
    kind: span.kind,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    traceFlags: span.traceFlags,
    startTime: span.startTime.toISOString(),
    endTime: span.endTime.toISOString(),
    durationMs: span.endTime.getTime() - span.startTime.getTime(),
    status: span.status,
    attributes: span.attributes,
    events: span.events.map((e) => ({
      name: e.name,
      timestamp: e.timestamp.toISOString(),
      attributes: e.attributes,
    })),
    links: span.links,
    resource: span.resource,
  };
}

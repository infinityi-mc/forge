/**
 * OTLP/HTTP JSON exporter for `forge/telemetry/trace`.
 *
 * @module
 */

import type {
  ReadableSpan,
  SpanEvent,
  SpanExporter,
  SpanKind,
  SpanLink,
  SpanStatus,
} from "../../trace/types";
import {
  encodeAttributes,
  encodeResource,
  toNanos,
  type KeyValue,
} from "./encoding";
import {
  createOtlpHttpClient,
  type OtlpHttpClientOptions,
} from "./transport";

export interface OtlpHttpTraceExporterOptions
  extends Omit<OtlpHttpClientOptions, "url"> {
  url?: string;
}

const SPAN_KIND_NUMBER: Readonly<Record<SpanKind, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_CODE_NUMBER: Readonly<Record<SpanStatus["code"], number>> = {
  unset: 0,
  ok: 1,
  error: 2,
};

export function otlpHttpTraceExporter(
  options: OtlpHttpTraceExporterOptions = {},
): SpanExporter {
  const { url = "http://localhost:4318/v1/traces", ...clientOpts } = options;
  const send = createOtlpHttpClient({ url, ...clientOpts });

  return {
    async export(spans: readonly ReadableSpan[]): Promise<void> {
      if (spans.length === 0) return;
      const body = JSON.stringify(buildBody(spans));
      await send(body);
    },
    async flush() {},
    async shutdown() {},
  };
}

function buildBody(spans: readonly ReadableSpan[]) {
  // OTLP groups spans by resource; in practice all spans from one
  // tracer share a resource, so we just emit a single entry.
  const resource = spans[0]!.resource;
  return {
    resourceSpans: [
      {
        resource: encodeResource(resource),
        scopeSpans: [
          {
            scope: { name: "forge/telemetry/trace" },
            spans: spans.map(encodeSpan),
          },
        ],
      },
    ],
  };
}

function encodeSpan(span: ReadableSpan) {
  const out: Record<string, unknown> = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: SPAN_KIND_NUMBER[span.kind],
    startTimeUnixNano: toNanos(span.startTime),
    endTimeUnixNano: toNanos(span.endTime),
    attributes: encodeAttributes(
      span.attributes as unknown as Record<string, unknown>,
    ),
    events: span.events.map(encodeEvent),
    links: span.links.map(encodeLink),
    status: encodeStatus(span.status),
    flags: span.traceFlags,
  };
  if (span.parentSpanId !== undefined) {
    out["parentSpanId"] = span.parentSpanId;
  }
  return out;
}

function encodeEvent(event: SpanEvent) {
  const attrs: KeyValue[] = event.attributes
    ? encodeAttributes(event.attributes as unknown as Record<string, unknown>)
    : [];
  return {
    timeUnixNano: toNanos(event.timestamp),
    name: event.name,
    attributes: attrs,
  };
}

function encodeLink(link: SpanLink) {
  const out: Record<string, unknown> = {
    traceId: link.traceId,
    spanId: link.spanId,
    attributes: link.attributes
      ? encodeAttributes(link.attributes as unknown as Record<string, unknown>)
      : [],
  };
  if (link.traceFlags !== undefined) out["flags"] = link.traceFlags;
  return out;
}

function encodeStatus(status: SpanStatus) {
  return status.message
    ? { code: STATUS_CODE_NUMBER[status.code], message: status.message }
    : { code: STATUS_CODE_NUMBER[status.code] };
}

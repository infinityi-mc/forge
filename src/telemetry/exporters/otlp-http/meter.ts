/**
 * OTLP/HTTP JSON exporter for `forge/telemetry/meter`.
 *
 * @module
 */

import type {
  HistogramPoint,
  MeterExporter,
  MetricBatch,
  MetricData,
  NumberPoint,
} from "../../meter/types";
import {
  encodeAttributes,
  encodeResource,
  toNanos,
} from "./encoding";
import {
  createOtlpHttpClient,
  type OtlpHttpClientOptions,
} from "./transport";

export interface OtlpHttpMeterExporterOptions
  extends Omit<OtlpHttpClientOptions, "url"> {
  url?: string;
}

const AGG_TEMPORALITY = {
  cumulative: 2,
  delta: 1,
} as const;

export function otlpHttpMeterExporter(
  options: OtlpHttpMeterExporterOptions = {},
): MeterExporter {
  const { url = "http://localhost:4318/v1/metrics", ...clientOpts } = options;
  const send = createOtlpHttpClient({ url, ...clientOpts });

  return {
    async export(batch: MetricBatch): Promise<void> {
      const body = JSON.stringify(buildBody(batch));
      await send(body);
    },
    async flush() {},
    async shutdown() {},
  };
}

function buildBody(batch: MetricBatch) {
  return {
    resourceMetrics: [
      {
        resource: encodeResource(batch.resource),
        scopeMetrics: [
          {
            scope: { name: "forge/telemetry/meter" },
            metrics: batch.metrics.map(encodeMetric),
          },
        ],
      },
    ],
  };
}

function encodeMetric(metric: MetricData) {
  const base = {
    name: metric.descriptor.name,
    description: metric.descriptor.description ?? "",
    unit: metric.descriptor.unit ?? "",
  };

  switch (metric.kind) {
    case "counter":
    case "up-down-counter":
      return {
        ...base,
        sum: {
          dataPoints: metric.points.map(encodeNumberPoint),
          aggregationTemporality: AGG_TEMPORALITY[metric.temporality],
          isMonotonic: metric.monotonic,
        },
      };
    case "gauge":
      return {
        ...base,
        gauge: {
          dataPoints: metric.points.map(encodeNumberPoint),
        },
      };
    case "histogram":
      return {
        ...base,
        histogram: {
          dataPoints: metric.points.map(encodeHistogramPoint),
          aggregationTemporality: AGG_TEMPORALITY[metric.temporality],
        },
      };
  }
}

function encodeNumberPoint(point: NumberPoint) {
  return {
    attributes: encodeAttributes(point.attributes as Record<string, unknown>),
    startTimeUnixNano: toNanos(point.startTime),
    timeUnixNano: toNanos(point.time),
    asDouble: point.value,
  };
}

function encodeHistogramPoint(point: HistogramPoint) {
  const dp: Record<string, unknown> = {
    attributes: encodeAttributes(point.attributes as Record<string, unknown>),
    startTimeUnixNano: toNanos(point.startTime),
    timeUnixNano: toNanos(point.time),
    count: String(point.count),
    sum: point.sum,
    bucketCounts: point.bucketCounts.map((n) => String(n)),
    explicitBounds: point.boundaries,
  };
  if (point.count > 0) {
    dp["min"] = point.min;
    dp["max"] = point.max;
  }
  return dp;
}

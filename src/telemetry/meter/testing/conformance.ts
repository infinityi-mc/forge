/**
 * Conformance scenarios + assertion helpers for `forge/telemetry/meter`.
 *
 * Run `STANDARD_METER_SCENARIOS` against any `MeterExporter` to verify
 * it satisfies the same invariants as the shipped exporters: it
 * accepts every metric kind, preserves attributes, doesn't reject
 * empty batches, and (when async) resolves cleanly.
 *
 * Helpers throw plain `Error`s on failure so they work under Bun's
 * built-in test runner, Vitest, Jest, or any other framework.
 *
 * @module
 */

import type { Resource } from "../../types";
import type {
  HistogramPoint,
  MeterExporter,
  MetricBatch,
  MetricData,
  NumberPoint,
} from "../types";

export interface MeterConformanceScenario {
  name: string;
  run(exporter: MeterExporter): Promise<void> | void;
  assert(batches: readonly MetricBatch[]): void;
}

const resource: Resource = {
  serviceName: "conformance",
  serviceVersion: "0.0.0",
  environment: "test",
};

function batchAt(time: Date, metrics: readonly MetricData[]): MetricBatch {
  return { resource, metrics, collectedAt: time };
}

function counterPoint(
  attributes: Record<string, string | number | boolean>,
  value: number,
  t: Date,
): NumberPoint {
  return { attributes, value, startTime: t, time: t };
}

function histPoint(
  attributes: Record<string, string | number | boolean>,
  t: Date,
): HistogramPoint {
  return {
    attributes,
    count: 3,
    sum: 30,
    min: 5,
    max: 15,
    boundaries: [10],
    bucketCounts: [2, 1],
    startTime: t,
    time: t,
  };
}

export const STANDARD_METER_SCENARIOS: readonly MeterConformanceScenario[] = [
  {
    name: "exporter accepts a counter batch",
    async run(exporter) {
      const t = new Date(2025, 0, 1);
      await exporter.export(
        batchAt(t, [
          {
            kind: "counter",
            descriptor: { name: "requests", kind: "counter" },
            temporality: "cumulative",
            monotonic: true,
            points: [counterPoint({ route: "/health" }, 7, t)],
          },
        ]),
      );
    },
    assert(batches) {
      assertBatchCount(batches, 1);
      const m = batches[0]!.metrics[0]!;
      if (m.kind !== "counter") throw new Error(`expected counter, got ${m.kind}`);
      assertPointCount(m.points, 1);
    },
  },
  {
    name: "exporter accepts an up-down-counter batch",
    async run(exporter) {
      const t = new Date(2025, 0, 2);
      await exporter.export(
        batchAt(t, [
          {
            kind: "up-down-counter",
            descriptor: { name: "queue.depth", kind: "up-down-counter" },
            temporality: "cumulative",
            monotonic: false,
            points: [counterPoint({ queue: "a" }, 4, t)],
          },
        ]),
      );
    },
    assert(batches) {
      assertBatchCount(batches, 1);
      const m = batches[0]!.metrics[0]!;
      if (m.kind !== "up-down-counter") {
        throw new Error(`expected up-down-counter, got ${m.kind}`);
      }
    },
  },
  {
    name: "exporter accepts a gauge batch",
    async run(exporter) {
      const t = new Date(2025, 0, 3);
      await exporter.export(
        batchAt(t, [
          {
            kind: "gauge",
            descriptor: { name: "temperature", kind: "gauge" },
            points: [counterPoint({ sensor: "a" }, 21, t)],
          },
        ]),
      );
    },
    assert(batches) {
      assertBatchCount(batches, 1);
      const m = batches[0]!.metrics[0]!;
      if (m.kind !== "gauge") throw new Error(`expected gauge, got ${m.kind}`);
    },
  },
  {
    name: "exporter accepts a histogram batch",
    async run(exporter) {
      const t = new Date(2025, 0, 4);
      await exporter.export(
        batchAt(t, [
          {
            kind: "histogram",
            descriptor: { name: "latency", kind: "histogram" },
            temporality: "delta",
            points: [histPoint({ route: "/api" }, t)],
          },
        ]),
      );
    },
    assert(batches) {
      assertBatchCount(batches, 1);
      const m = batches[0]!.metrics[0]!;
      if (m.kind !== "histogram") {
        throw new Error(`expected histogram, got ${m.kind}`);
      }
      assertPointCount(m.points, 1);
      assertHistogramInvariant(m.points[0] as HistogramPoint);
    },
  },
  {
    name: "exporter accepts an empty batch without error",
    async run(exporter) {
      const t = new Date(2025, 0, 5);
      await exporter.export(batchAt(t, []));
    },
    assert(batches) {
      assertBatchCount(batches, 1);
      if (batches[0]!.metrics.length !== 0) {
        throw new Error("expected empty metrics in empty batch");
      }
    },
  },
  {
    name: "exporter does not mutate the batch it received",
    async run(exporter) {
      const t = new Date(2025, 0, 6);
      const frozen = Object.freeze({
        resource,
        metrics: Object.freeze([]),
        collectedAt: t,
      }) as MetricBatch;
      // throws if the exporter mutates a frozen field
      await exporter.export(frozen);
    },
    assert(batches) {
      assertBatchCount(batches, 1);
    },
  },
];

export interface RecordingMeterHandle {
  exporter: MeterExporter;
  batches: readonly MetricBatch[];
}

export function recordingMeterHandle(): RecordingMeterHandle {
  const batches: MetricBatch[] = [];
  return {
    batches,
    exporter: { export: (batch) => void batches.push(batch) },
  };
}

// ────────────────────────────────────────────────────────────────────
// Assertion helpers
// ────────────────────────────────────────────────────────────────────

export function assertBatchCount(
  batches: readonly MetricBatch[],
  expected: number,
): void {
  if (batches.length !== expected) {
    throw new Error(`expected ${expected} batch(es), got ${batches.length}`);
  }
}

export function assertPointCount(
  points: readonly unknown[],
  expected: number,
): void {
  if (points.length !== expected) {
    throw new Error(`expected ${expected} point(s), got ${points.length}`);
  }
}

export function assertHistogramInvariant(point: HistogramPoint): void {
  if (point.bucketCounts.length !== point.boundaries.length + 1) {
    throw new Error(
      `histogram bucket count mismatch: bucketCounts.length=${point.bucketCounts.length}, boundaries.length+1=${point.boundaries.length + 1}`,
    );
  }
  const bucketSum = point.bucketCounts.reduce((a, b) => a + b, 0);
  if (bucketSum !== point.count) {
    throw new Error(
      `histogram sum of bucketCounts (${bucketSum}) != count (${point.count})`,
    );
  }
  if (
    point.min !== undefined &&
    point.max !== undefined &&
    point.min > point.max
  ) {
    throw new Error(
      `histogram min (${point.min}) > max (${point.max})`,
    );
  }
}

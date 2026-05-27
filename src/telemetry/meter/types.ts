/**
 * Types for `forge/telemetry/meter`.
 *
 * Naming follows OpenTelemetry's metrics terminology so the OTLP
 * exporter has a one-to-one shape mapping. The wire layer is
 * orthogonal — consumers may write their own exporters that target
 * StatsD, Datadog, Prometheus push-gateway, etc.
 *
 * @module
 */

import type { Resource } from "../types";

/**
 * Attribute set attached to a metric point. Values are stringly typed
 * to match OTel + Prometheus + StatsD conventions; non-string values
 * are coerced via `String()` by the meter before aggregation so the
 * series key is stable.
 */
export type MetricAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * Instrument kinds. The kind determines the aggregation strategy used
 * by the meter and dictates how the point is encoded in OTLP/Prometheus.
 */
export type InstrumentKind =
  | "counter"
  | "up-down-counter"
  | "gauge"
  | "histogram";

/**
 * Temporality of a numeric instrument. `cumulative` reports a running
 * total since the meter started; `delta` reports the change since the
 * last collection. Counters default to `cumulative`; histograms always
 * report delta windows.
 */
export type AggregationTemporality = "cumulative" | "delta";

export interface InstrumentDescriptor {
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly description?: string;
  readonly unit?: string;
}

/**
 * A monotonic counter. Use for things that only ever go up — request
 * counts, byte counters, errors.
 */
export interface Counter {
  readonly descriptor: InstrumentDescriptor;
  /** Increment by a non-negative delta. */
  add(value: number, attributes?: MetricAttributes): void;
}

/**
 * A bi-directional counter. Use for things that go both up and down —
 * queue depth, connection count, in-flight requests.
 */
export interface UpDownCounter {
  readonly descriptor: InstrumentDescriptor;
  add(value: number, attributes?: MetricAttributes): void;
}

/**
 * A last-value gauge. Use for instantaneous samples — temperature,
 * memory usage, current rate.
 */
export interface Gauge {
  readonly descriptor: InstrumentDescriptor;
  /** Record the current value. Replaces any prior value for the same attributes. */
  record(value: number, attributes?: MetricAttributes): void;
}

/**
 * A bucketed distribution. Use for latencies, sizes, anything where
 * percentiles matter.
 */
export interface Histogram {
  readonly descriptor: InstrumentDescriptor;
  record(value: number, attributes?: MetricAttributes): void;
}

export interface CounterOptions {
  description?: string;
  unit?: string;
}

export interface UpDownCounterOptions {
  description?: string;
  unit?: string;
}

export interface GaugeOptions {
  description?: string;
  unit?: string;
}

export interface HistogramOptions {
  description?: string;
  unit?: string;
  /**
   * Explicit bucket upper boundaries in ascending order. The implicit
   * `+Inf` bucket is always present. Defaults to a latency-shaped set:
   * `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`.
   */
  boundaries?: readonly number[];
}

export interface NumberPoint {
  readonly attributes: MetricAttributes;
  readonly value: number;
  readonly startTime: Date;
  readonly time: Date;
}

export interface HistogramPoint {
  readonly attributes: MetricAttributes;
  readonly count: number;
  readonly sum: number;
  readonly min?: number;
  readonly max?: number;
  /** Explicit bucket upper boundaries (ascending). */
  readonly boundaries: readonly number[];
  /**
   * One count per bucket: `bucketCounts[i]` is the count of values
   * `<= boundaries[i]` (for `i < boundaries.length`) or `> last bound`
   * (final entry; implicit `+Inf` bucket). Always
   * `bucketCounts.length === boundaries.length + 1`.
   */
  readonly bucketCounts: readonly number[];
  readonly startTime: Date;
  readonly time: Date;
}

/**
 * Per-instrument metric data emitted on every collection cycle.
 * Discriminated by `kind` so exporters can switch encoding strategies.
 */
export type MetricData =
  | {
      readonly kind: "counter" | "up-down-counter";
      readonly descriptor: InstrumentDescriptor;
      readonly temporality: AggregationTemporality;
      readonly monotonic: boolean;
      readonly points: readonly NumberPoint[];
    }
  | {
      readonly kind: "gauge";
      readonly descriptor: InstrumentDescriptor;
      readonly points: readonly NumberPoint[];
    }
  | {
      readonly kind: "histogram";
      readonly descriptor: InstrumentDescriptor;
      readonly temporality: AggregationTemporality;
      readonly points: readonly HistogramPoint[];
    };

/**
 * A complete metric collection batch. One per collection cycle.
 */
export interface MetricBatch {
  readonly resource: Resource;
  readonly metrics: readonly MetricData[];
  readonly collectedAt: Date;
}

/**
 * Final sink for metric batches. Implementations write to stdout,
 * OTLP/HTTP, Prometheus scrape endpoints, etc.
 */
export interface MeterExporter {
  export(batch: MetricBatch): Promise<void> | void;
  flush?(options?: { signal?: AbortSignal }): Promise<void>;
  shutdown?(): Promise<void>;
}

export type MeterMiddleware = (next: MeterExporter) => MeterExporter;

export interface MeterOptions {
  /** Resource attributes attached to every metric batch. */
  resource: Resource;
  /** Final destination for metric batches. */
  exporter: MeterExporter;
  /** Middleware applied outermost-first. */
  middleware?: readonly MeterMiddleware[];
  /**
   * Period (ms) for automatic collection + export. Set to `0` to
   * disable the timer — consumers then call `meter.collect()` manually.
   * Defaults to `60_000`.
   */
  intervalMs?: number;
  /**
   * Temporality reported by counters and histograms. Defaults to
   * `"cumulative"` (matches OTLP default + Prometheus shape).
   */
  temporality?: AggregationTemporality;
  /** Propagate exporter throws to the timer task. Defaults to `false`. */
  propagateExporterErrors?: boolean;
  /** Override the clock source for tests. */
  now?: () => number;
}

export interface Meter {
  createCounter(name: string, options?: CounterOptions): Counter;
  createUpDownCounter(name: string, options?: UpDownCounterOptions): UpDownCounter;
  createGauge(name: string, options?: GaugeOptions): Gauge;
  createHistogram(name: string, options?: HistogramOptions): Histogram;
  /** Collect all instruments and hand the batch to the exporter. */
  collect(): Promise<void>;
  /** Drain any pending batches. */
  flush?(options?: { signal?: AbortSignal }): Promise<void>;
  /** Stop the periodic timer and release resources. */
  shutdown(): Promise<void>;
}

export type CreateMeter = (options: MeterOptions) => Meter;

/**
 * Default explicit boundaries for histograms — latency-shaped (ms).
 * Matches the OpenTelemetry SDK default.
 */
export const DEFAULT_HISTOGRAM_BOUNDARIES: readonly number[] = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];

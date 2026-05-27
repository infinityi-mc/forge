/**
 * Metrics for `forge/telemetry`.
 *
 * @example
 * ```ts
 * import { createMeter } from "forge/telemetry/meter";
 * import { stdoutMeterExporter } from "forge/telemetry/meter/exporters/stdout";
 *
 * const meter = createMeter({
 *   resource: { serviceName: "api" },
 *   exporter: stdoutMeterExporter(),
 *   intervalMs: 10_000,
 * });
 *
 * const requests = meter.createCounter("http.requests", { unit: "1" });
 * requests.add(1, { method: "GET", path: "/health" });
 *
 * const latency = meter.createHistogram("http.duration", { unit: "ms" });
 * latency.record(42, { method: "POST", path: "/users" });
 * ```
 *
 * @module
 */

export { createMeter } from "./meter";
export {
  DEFAULT_HISTOGRAM_BOUNDARIES,
  type AggregationTemporality,
  type Counter,
  type CounterOptions,
  type CreateMeter,
  type Gauge,
  type GaugeOptions,
  type Histogram,
  type HistogramOptions,
  type InstrumentDescriptor,
  type InstrumentKind,
  type Meter,
  type MeterExporter,
  type MeterMiddleware,
  type MeterOptions,
  type MetricAttributes,
  type MetricBatch,
  type MetricData,
  type NumberPoint,
  type HistogramPoint,
  type UpDownCounter,
  type UpDownCounterOptions,
} from "./types";

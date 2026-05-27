/**
 * `initTelemetry` — top-level factory that wires log + meter + trace
 * around a single {@link Resource} and returns a unified
 * {@link Telemetry} handle.
 *
 * Each signal is independently optional: omit a section and the
 * corresponding member is `undefined`. When present, the section
 * mirrors the underlying factory's options (`createLog`,
 * `createMeter`, `createTracer`) with a tiny ergonomic addition for
 * tracing: pick the processor by short name (`"simple"` / `"batch"`)
 * or supply a fully-formed processor instance.
 *
 * `flush()` and `shutdown()` fan-out to every configured signal and
 * never throw — errors are isolated per signal and aggregated into
 * the resolved value so the host application can pick the right
 * recovery strategy at the call site.
 *
 * @example
 * ```ts
 * import { initTelemetry } from "forge/telemetry";
 * import { stdoutLogExporter } from "forge/telemetry/log/exporters/stdout";
 * import { stdoutMeterExporter } from "forge/telemetry/meter/exporters/stdout";
 * import { stdoutSpanExporter } from "forge/telemetry/trace/exporters/stdout";
 *
 * const t = initTelemetry({
 *   resource: { serviceName: "api" },
 *   log: { exporter: stdoutLogExporter() },
 *   meter: { exporter: stdoutMeterExporter(), intervalMs: 10_000 },
 *   trace: { exporter: stdoutSpanExporter(), processor: "batch" },
 * });
 *
 * t.log.info("ready");
 * await t.shutdown();
 * ```
 *
 * @module
 */

import { createLog } from "./log/log";
import type {
  LogAttributes,
  LogExporter,
  LogLevel,
  LogMiddleware,
  Logger,
} from "./log/types";
import { createMeter } from "./meter/meter";
import type {
  AggregationTemporality,
  Meter,
  MeterExporter,
  MeterMiddleware,
} from "./meter/types";
import { batchSpanProcessor } from "./trace/processors/batch";
import type { BatchSpanProcessorOptions } from "./trace/processors/batch";
import { simpleSpanProcessor } from "./trace/processors/simple";
import { createTracer } from "./trace/tracer";
import type {
  Sampler,
  SpanExporter,
  SpanProcessor,
  Tracer,
} from "./trace/types";
import type { Resource } from "./types";

export interface InitTelemetryLogOptions {
  exporter: LogExporter;
  level?: LogLevel;
  attributes?: LogAttributes;
  middleware?: readonly LogMiddleware[];
  propagateExporterErrors?: boolean;
}

export interface InitTelemetryMeterOptions {
  exporter: MeterExporter;
  middleware?: readonly MeterMiddleware[];
  intervalMs?: number;
  temporality?: AggregationTemporality;
  propagateExporterErrors?: boolean;
}

/**
 * Pick a built-in processor by short name, or supply a fully-formed
 * one. Defaults to `"batch"` because that is the safe production
 * choice; `"simple"` is best reserved for tests + scripts.
 */
export type InitTelemetryTraceProcessor =
  | "simple"
  | "batch"
  | { kind: "simple"; propagateExporterErrors?: boolean }
  | ({ kind: "batch" } & Omit<BatchSpanProcessorOptions, "exporter">)
  | SpanProcessor;

export interface InitTelemetryTraceOptions {
  exporter: SpanExporter;
  sampler?: Sampler;
  processor?: InitTelemetryTraceProcessor;
  now?: () => Date;
}

export interface InitTelemetryOptions {
  /** Resource attached to every record/metric/span. */
  resource: Resource;
  log?: InitTelemetryLogOptions;
  meter?: InitTelemetryMeterOptions;
  trace?: InitTelemetryTraceOptions;
}

export interface Telemetry {
  readonly resource: Resource;
  readonly log: Logger | undefined;
  readonly meter: Meter | undefined;
  readonly tracer: Tracer | undefined;
  /** Drain pending data on every configured signal. */
  flush(options?: { signal?: AbortSignal }): Promise<TelemetryFlushResult>;
  /** Stop background work and release resources. */
  shutdown(): Promise<TelemetryFlushResult>;
}

/**
 * Per-signal outcome of `flush()` / `shutdown()`. Errors are
 * collected, not thrown, so a single failing signal doesn't mask the
 * others.
 */
export interface TelemetryFlushResult {
  readonly log?: { ok: true } | { ok: false; error: unknown };
  readonly meter?: { ok: true } | { ok: false; error: unknown };
  readonly trace?: { ok: true } | { ok: false; error: unknown };
}

export function initTelemetry(options: InitTelemetryOptions): Telemetry {
  const { resource } = options;

  const logger = options.log
    ? createLog({
        exporter: options.log.exporter,
        level: options.log.level,
        attributes: options.log.attributes,
        middleware: options.log.middleware,
        propagateExporterErrors: options.log.propagateExporterErrors,
      })
    : undefined;

  const meter = options.meter
    ? createMeter({
        resource,
        exporter: options.meter.exporter,
        middleware: options.meter.middleware,
        intervalMs: options.meter.intervalMs,
        temporality: options.meter.temporality,
        propagateExporterErrors: options.meter.propagateExporterErrors,
      })
    : undefined;

  let traceProcessor: SpanProcessor | undefined;
  let tracer: Tracer | undefined;
  if (options.trace) {
    traceProcessor = resolveProcessor(options.trace);
    tracer = createTracer({
      resource,
      sampler: options.trace.sampler,
      processor: traceProcessor,
      now: options.trace.now,
    });
  }

  async function flush(opts?: { signal?: AbortSignal }): Promise<TelemetryFlushResult> {
    const out: { -readonly [K in keyof TelemetryFlushResult]: TelemetryFlushResult[K] } = {};
    if (logger?.flush) out.log = await runSafe(() => logger.flush!(opts));
    if (meter?.flush) out.meter = await runSafe(() => meter.flush!(opts));
    if (traceProcessor?.forceFlush)
      out.trace = await runSafe(() => traceProcessor!.forceFlush!());
    return out;
  }

  async function shutdown(): Promise<TelemetryFlushResult> {
    const out: { -readonly [K in keyof TelemetryFlushResult]: TelemetryFlushResult[K] } = {};
    if (logger?.flush) out.log = await runSafe(() => logger.flush!());
    if (meter) out.meter = await runSafe(() => meter.shutdown());
    if (traceProcessor) out.trace = await runSafe(() => traceProcessor!.shutdown());
    return out;
  }

  return {
    resource,
    log: logger,
    meter,
    tracer,
    flush,
    shutdown,
  };
}

function resolveProcessor(opts: InitTelemetryTraceOptions): SpanProcessor {
  const p = opts.processor;
  if (p === undefined || p === "batch") {
    return batchSpanProcessor({ exporter: opts.exporter });
  }
  if (p === "simple") {
    return simpleSpanProcessor({ exporter: opts.exporter });
  }
  if (typeof p === "object" && "kind" in p && (p.kind === "simple" || p.kind === "batch")) {
    if (p.kind === "simple") {
      return simpleSpanProcessor({
        exporter: opts.exporter,
        propagateExporterErrors: p.propagateExporterErrors,
      });
    }
    const { kind: _ignored, ...rest } = p;
    return batchSpanProcessor({ exporter: opts.exporter, ...rest });
  }
  // Already a fully-formed SpanProcessor.
  return p as SpanProcessor;
}

async function runSafe(
  fn: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

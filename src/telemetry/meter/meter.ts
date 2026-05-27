/**
 * `createMeter` — factory for the meter subsystem.
 *
 * Creates instruments (counter, up-down-counter, gauge, histogram),
 * manages internal aggregation, and drives a periodic collection +
 * export loop. Consumers call `meter.shutdown()` to stop the timer
 * and flush remaining data.
 *
 * @module
 */

import { serializeError } from "../log/serialize";
import { MeterExporterError } from "./errors";
import { MetricStore } from "./store";
import {
  DEFAULT_HISTOGRAM_BOUNDARIES,
  type AggregationTemporality,
  type Counter,
  type CreateMeter,
  type Gauge,
  type GaugeOptions,
  type Histogram,
  type HistogramOptions,
  type InstrumentDescriptor,
  type Meter,
  type MeterExporter,
  type MeterMiddleware,
  type MeterOptions,
  type MetricAttributes,
  type UpDownCounter,
  type UpDownCounterOptions,
  type CounterOptions,
} from "./types";

function applyMiddleware(
  exporter: MeterExporter,
  middleware: readonly MeterMiddleware[] | undefined,
): MeterExporter {
  if (!middleware || middleware.length === 0) return exporter;
  let wrapped = exporter;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw) continue;
    const inner = wrapped;
    wrapped = mw(inner);
    if (!wrapped.flush && inner.flush) {
      wrapped.flush = inner.flush.bind(inner);
    }
    if (!wrapped.shutdown && inner.shutdown) {
      wrapped.shutdown = inner.shutdown.bind(inner);
    }
  }
  return wrapped;
}

function normalizeAttributes(attrs?: MetricAttributes): MetricAttributes {
  return attrs ?? {};
}

export const createMeter: CreateMeter = (options: MeterOptions): Meter => {
  const {
    resource,
    exporter,
    middleware,
    intervalMs = 60_000,
    temporality = "cumulative",
    propagateExporterErrors = false,
    now = Date.now,
  } = options;

  const store = new MetricStore(() => new Date(now()));
  const wrapped = applyMiddleware(exporter, middleware);
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  if (intervalMs > 0) {
    timer = setInterval(() => {
      doCollect().catch(() => {});
    }, intervalMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  async function doCollect(): Promise<void> {
    const metrics = store.collect(temporality);
    if (metrics.length === 0) return;
    const batch = { resource, metrics, collectedAt: new Date(now()) };
    try {
      await wrapped.export(batch);
    } catch (error) {
      if (propagateExporterErrors) throw error;
      writeExporterFailureFallback(error, batch);
    }
  }

  function writeExporterFailureFallback(error: unknown, _batch: unknown): void {
    const wrapped =
      error instanceof MeterExporterError
        ? error
        : new MeterExporterError("meter exporter failed", { cause: error });
    const fallback = {
      level: "error",
      msg: "meter exporter failed",
      err: serializeError(wrapped),
    };
    try {
      process.stderr.write(`${JSON.stringify(fallback)}\n`);
    } catch {
      // Last-resort fallback.
    }
  }

  return {
    createCounter(name: string, opts?: CounterOptions): Counter {
      const descriptor: InstrumentDescriptor = {
        name,
        kind: "counter",
        description: opts?.description,
        unit: opts?.unit,
      };
      store.registerNumberInstrument(descriptor, "counter", true);
      return {
        descriptor,
        add(value: number, attributes?: MetricAttributes) {
          if (value < 0 || !Number.isFinite(value)) return;
          store.addToNumber(name, value, normalizeAttributes(attributes));
        },
      };
    },

    createUpDownCounter(name: string, opts?: UpDownCounterOptions): UpDownCounter {
      const descriptor: InstrumentDescriptor = {
        name,
        kind: "up-down-counter",
        description: opts?.description,
        unit: opts?.unit,
      };
      store.registerNumberInstrument(descriptor, "up-down-counter", false);
      return {
        descriptor,
        add(value: number, attributes?: MetricAttributes) {
          if (!Number.isFinite(value)) return;
          store.addToNumber(name, value, normalizeAttributes(attributes));
        },
      };
    },

    createGauge(name: string, opts?: GaugeOptions): Gauge {
      const descriptor: InstrumentDescriptor = {
        name,
        kind: "gauge",
        description: opts?.description,
        unit: opts?.unit,
      };
      store.registerNumberInstrument(descriptor, "gauge", false);
      return {
        descriptor,
        record(value: number, attributes?: MetricAttributes) {
          if (!Number.isFinite(value)) return;
          store.setNumber(name, value, normalizeAttributes(attributes));
        },
      };
    },

    createHistogram(name: string, opts?: HistogramOptions): Histogram {
      const boundaries = opts?.boundaries
        ? [...opts.boundaries].sort((a, b) => a - b)
        : [...DEFAULT_HISTOGRAM_BOUNDARIES];
      const descriptor: InstrumentDescriptor = {
        name,
        kind: "histogram",
        description: opts?.description,
        unit: opts?.unit,
      };
      store.registerHistogramInstrument(descriptor, boundaries);
      return {
        descriptor,
        record(value: number, attributes?: MetricAttributes) {
          if (!Number.isFinite(value)) return;
          store.recordHistogram(name, value, normalizeAttributes(attributes));
        },
      };
    },

    async collect() {
      if (stopped) return;
      await doCollect();
    },

    async flush(flushOptions) {
      await doCollect();
      await wrapped.flush?.(flushOptions);
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await doCollect();
      await wrapped.shutdown?.();
    },
  };
};

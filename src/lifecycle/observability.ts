/**
 * Opt-in, structurally-typed observability for `forge/lifecycle`.
 *
 * Boot and shutdown emit the `lifecycle.*` metric surface and per-phase spans
 * **only** when a {@link LifecycleTelemetry} handle is injected; with no handle
 * every helper here collapses to a no-op, so standalone usage emits nothing and
 * carries no `forge/telemetry` dependency.
 *
 * Because telemetry is itself usually the *first* component started and the
 * *last* stopped, every emit is wrapped so a not-yet-started or already-shut
 * instrument can never throw back into the orchestrator — a failed emit is
 * silently dropped rather than aborting boot or shutdown.
 *
 * @module
 */

import type {
  Attributes,
  CounterLike,
  HistogramLike,
  LifecycleTelemetry,
  SpanLike,
  TracerLike,
  UpDownCounterLike,
} from "./types";

const NOOP_COUNTER: CounterLike = { add() {} };
const NOOP_HISTOGRAM: HistogramLike = { record() {} };
const NOOP_UPDOWN_COUNTER: UpDownCounterLike = { add() {} };

/** A span that records nothing. Returned when no tracer is injected. */
export const NOOP_SPAN: SpanLike = {
  setAttribute() {
    return undefined;
  },
  setStatus() {
    return undefined;
  },
  end() {},
};

/** Swallow any throw from a telemetry instrument that is mid-start / shut. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a not-yet-started / already-shut telemetry handle must not break us */
  }
}

/** Guard a counter so `add` can never throw into the orchestrator. */
function guardCounter(counter: CounterLike): CounterLike {
  return {
    add(value, attributes) {
      safe(() => counter.add(value, attributes));
    },
  };
}

/** Guard a histogram so `record` can never throw into the orchestrator. */
function guardHistogram(histogram: HistogramLike): HistogramLike {
  return {
    record(value, attributes) {
      safe(() => histogram.record(value, attributes));
    },
  };
}

/** Guard an up-down counter so `add` can never throw into the orchestrator. */
function guardUpDownCounter(counter: UpDownCounterLike): UpDownCounterLike {
  return {
    add(value, attributes) {
      safe(() => counter.add(value, attributes));
    },
  };
}

/** The `lifecycle.*` instruments emitted by boot/shutdown and the probe. */
export interface LifecycleMetrics {
  /** Total time to `ready`, in ms. */
  readonly bootDuration: HistogramLike;
  /** Per-component `start()` time, in ms (labels: `component`, `outcome`). */
  readonly startDuration: HistogramLike;
  /** Per-component `stop()` time, in ms (labels: `component`, `outcome`). */
  readonly stopDuration: HistogramLike;
  /** Total graceful-shutdown time, in ms. */
  readonly shutdownDuration: HistogramLike;
  /** Components abandoned after overrunning their stop slice. */
  readonly stopTimeout: CounterLike;
  /** 1 when the app is ready, 0 otherwise. */
  readonly ready: UpDownCounterLike;
  /** Per-check health time, in ms (labels: `check`, `status`). */
  readonly healthCheckDuration: HistogramLike;
}

/**
 * Build the `lifecycle.*` instruments once per {@link boot}. With no meter the
 * instruments are no-ops, so call sites never branch on telemetry being
 * present. Instrument creation is itself guarded so a meter that throws while
 * telemetry is mid-start degrades to no-ops rather than failing boot.
 */
export function createLifecycleMetrics(
  telemetry?: LifecycleTelemetry,
): LifecycleMetrics {
  const meter = telemetry?.meter;
  if (meter === undefined) {
    return {
      bootDuration: NOOP_HISTOGRAM,
      startDuration: NOOP_HISTOGRAM,
      stopDuration: NOOP_HISTOGRAM,
      shutdownDuration: NOOP_HISTOGRAM,
      stopTimeout: NOOP_COUNTER,
      ready: NOOP_UPDOWN_COUNTER,
      healthCheckDuration: NOOP_HISTOGRAM,
    };
  }

  try {
    return {
      bootDuration: guardHistogram(
        meter.createHistogram("lifecycle.boot.duration", {
          description: "Total time from boot start to ready",
          unit: "ms",
        }),
      ),
      startDuration: guardHistogram(
        meter.createHistogram("lifecycle.component.start.duration", {
          description: "Time for a component's start() to complete",
          unit: "ms",
        }),
      ),
      stopDuration: guardHistogram(
        meter.createHistogram("lifecycle.component.stop.duration", {
          description: "Time for a component's stop() to complete",
          unit: "ms",
        }),
      ),
      shutdownDuration: guardHistogram(
        meter.createHistogram("lifecycle.shutdown.duration", {
          description: "Total graceful-shutdown time",
          unit: "ms",
        }),
      ),
      stopTimeout: guardCounter(
        meter.createCounter("lifecycle.component.stop.timeout", {
          description: "Components abandoned after overrunning their stop slice",
        }),
      ),
      // Up-down counters are optional on `MeterLike`; fall back to a no-op
      // so meters that predate the instrument still work.
      ready:
        meter.createUpDownCounter === undefined
          ? NOOP_UPDOWN_COUNTER
          : guardUpDownCounter(
              meter.createUpDownCounter("lifecycle.ready", {
                description: "1 when the application is ready, 0 otherwise",
              }),
            ),
      healthCheckDuration: guardHistogram(
        meter.createHistogram("lifecycle.health.check.duration", {
          description: "Time for a single component healthcheck",
          unit: "ms",
        }),
      ),
    };
  } catch {
    return {
      bootDuration: NOOP_HISTOGRAM,
      startDuration: NOOP_HISTOGRAM,
      stopDuration: NOOP_HISTOGRAM,
      shutdownDuration: NOOP_HISTOGRAM,
      stopTimeout: NOOP_COUNTER,
      ready: NOOP_UPDOWN_COUNTER,
      healthCheckDuration: NOOP_HISTOGRAM,
    };
  }
}

/**
 * Run `fn` inside an optional span. With no tracer the span is a no-op and `fn`
 * runs directly. The span is marked `error` and ended on a thrown error, `ok`
 * otherwise. Span creation/finalization is guarded so a mid-start tracer can
 * never throw into the orchestrator.
 */
export async function withSpan<T>(
  tracer: TracerLike | undefined,
  name: string,
  options: {
    kind?: "internal" | "server" | "client" | "producer" | "consumer";
    attributes?: Attributes;
  },
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  if (tracer === undefined) {
    return fn(NOOP_SPAN);
  }
  let span: SpanLike;
  try {
    span = tracer.startSpan(name, options);
  } catch {
    return fn(NOOP_SPAN);
  }
  try {
    const result = await fn(span);
    safe(() => span.setStatus({ code: "ok" }));
    return result;
  } catch (error) {
    safe(() =>
      span.setStatus({
        code: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    safe(() => span.end());
  }
}

/** Wall-clock milliseconds for duration histograms. */
export function now(): number {
  return performance.now();
}

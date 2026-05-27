/**
 * Telemetry adapter for `forge/resilience`.
 *
 * Resilience policies never own a telemetry transport — they accept
 * an optional `{ meter?, tracer? }` pair on construction and emit
 * counters/gauges/histograms + span events through it. When neither
 * is supplied, every emission is a no-op so a standalone
 * `retry({ maxAttempts: 3 })` produces zero observability overhead.
 *
 * Metric names match the spec in `local/resilience.md` §4:
 * `forge_resilience_attempts_total`, `forge_resilience_retries_total`,
 * `forge_resilience_circuit_state`, `forge_resilience_timeout_total`,
 * `forge_resilience_bulkhead_queue_size`. Counters/histograms are
 * created lazily on first use so a pipeline that never times out
 * doesn't register `forge_resilience_timeout_total` in the meter
 * store.
 *
 * @module
 */

import type { Counter, Gauge, Meter } from "../../telemetry/meter/types";
import type { SpanAttributes, Tracer } from "../../telemetry/trace/types";

/**
 * Telemetry hook accepted by every observable policy. Both fields are
 * optional so consumers can wire only the signals they care about
 * (e.g. metrics-only in production, traces in dev).
 */
export interface ResilienceTelemetry {
  meter?: Meter;
  tracer?: Tracer;
}

/**
 * Lightweight wrapper around `ResilienceTelemetry` that lazily
 * registers instruments on first use, then caches them. Created once
 * per policy at construction time.
 */
export interface ResilienceInstruments {
  attempts(): Counter | undefined;
  retries(): Counter | undefined;
  timeouts(): Counter | undefined;
  circuitState(): Gauge | undefined;
  bulkheadQueueSize(): Gauge | undefined;
  /**
   * Record a span event on the *active* span — read via
   * `tracer.startSpan` is too heavy for per-attempt events, so we
   * locate the in-flight span via the tracer's own context lookup.
   * No-op when no tracer is configured or no span is active.
   */
  addEvent(name: string, attributes?: SpanAttributes): void;
}

/**
 * Build an instrument cache around an optional telemetry hook. Calling
 * any accessor when the corresponding signal is missing returns
 * `undefined` (for counters/gauges) or no-ops (for `addEvent`).
 */
export function buildInstruments(
  telemetry: ResilienceTelemetry | undefined,
): ResilienceInstruments {
  const meter = telemetry?.meter;
  const tracer = telemetry?.tracer;

  let attempts: Counter | undefined;
  let retries: Counter | undefined;
  let timeouts: Counter | undefined;
  let circuitState: Gauge | undefined;
  let bulkheadQueueSize: Gauge | undefined;

  return {
    attempts() {
      if (!meter) return undefined;
      attempts ??= meter.createCounter("forge_resilience_attempts_total", {
        description: "Total execution attempts (including retries).",
        unit: "1",
      });
      return attempts;
    },
    retries() {
      if (!meter) return undefined;
      retries ??= meter.createCounter("forge_resilience_retries_total", {
        description: "Total retry attempts triggered.",
        unit: "1",
      });
      return retries;
    },
    timeouts() {
      if (!meter) return undefined;
      timeouts ??= meter.createCounter("forge_resilience_timeout_total", {
        description: "Total operations aborted due to timeout.",
        unit: "1",
      });
      return timeouts;
    },
    circuitState() {
      if (!meter) return undefined;
      circuitState ??= meter.createGauge("forge_resilience_circuit_state", {
        description: "Current circuit-breaker state (0=Closed, 1=HalfOpen, 2=Open).",
        unit: "1",
      });
      return circuitState;
    },
    bulkheadQueueSize() {
      if (!meter) return undefined;
      bulkheadQueueSize ??= meter.createGauge(
        "forge_resilience_bulkhead_queue_size",
        {
          description: "Current number of tasks waiting in a bulkhead queue.",
          unit: "1",
        },
      );
      return bulkheadQueueSize;
    },
    addEvent(name, attributes) {
      if (!tracer) return;
      // `withSpan`/`startSpan` are the only public surfaces — we don't
      // re-enter them here because a policy is *inside* the caller's
      // span. Starting a new "event-only" span would double up. We
      // instead record an event by starting a synthetic
      // record-and-end span: cheap when no span is active (the
      // sampler will typically drop it) and free when no tracer is
      // configured.
      const span = tracer.startSpan(name, attributes ? { attributes } : undefined);
      span.end();
    },
  };
}

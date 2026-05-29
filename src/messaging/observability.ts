/**
 * Opt-in, structurally-typed observability for `forge/messaging`.
 *
 * The bus and consumers emit metrics and spans **only** when a
 * {@link MessagingTelemetry} handle is injected. When it is absent every
 * helper here collapses to a no-op, so standalone usage emits nothing
 * and carries no `forge/telemetry` dependency.
 *
 * @module
 */

import type {
  Attributes,
  CounterLike,
  HistogramLike,
  Logger,
  LogAttributes,
  MessagingTelemetry,
  SpanLike,
  TracerLike,
} from "./types";

const NOOP_COUNTER: CounterLike = { add() {} };
const NOOP_HISTOGRAM: HistogramLike = { record() {} };

/** A logger whose every method discards its input. */
export const NOOP_LOGGER: Logger = {
  debug(_msg: string, _attrs?: LogAttributes) {},
  info(_msg: string, _attrs?: LogAttributes) {},
  warn(_msg: string, _attrs?: LogAttributes) {},
  error(_msg: string, _attrs?: LogAttributes) {},
};

/** Metric instruments shared by a bus or consumer instance. */
export interface MessagingMetrics {
  readonly published: CounterLike;
  readonly publishDuration: HistogramLike;
  readonly consumed: CounterLike;
  readonly consumeDuration: HistogramLike;
}

/**
 * Build the metric instruments once per bus / consumer. With no meter
 * the instruments are no-ops, so call sites never branch on telemetry
 * being present.
 */
export function createMetrics(telemetry?: MessagingTelemetry): MessagingMetrics {
  const meter = telemetry?.meter;
  if (meter === undefined) {
    return {
      published: NOOP_COUNTER,
      publishDuration: NOOP_HISTOGRAM,
      consumed: NOOP_COUNTER,
      consumeDuration: NOOP_HISTOGRAM,
    };
  }
  return {
    published: meter.createCounter("messaging.messages.published", {
      description: "Messages accepted by the transport for publishing",
    }),
    publishDuration: meter.createHistogram("messaging.publish.duration", {
      description: "Time to publish a message",
      unit: "ms",
    }),
    consumed: meter.createCounter("messaging.messages.consumed", {
      description: "Messages handled by a consumer",
    }),
    consumeDuration: meter.createHistogram("messaging.consume.duration", {
      description: "Time to handle a consumed message",
      unit: "ms",
    }),
  };
}

/**
 * Run `fn` inside an optional span. When no tracer is present the span
 * is a no-op and `fn` runs directly. The span is marked `error` and
 * ended on a thrown error, `ok` otherwise.
 */
export async function withSpan<T>(
  tracer: TracerLike | undefined,
  name: string,
  options: {
    kind?: "internal" | "producer" | "consumer";
    attributes?: Attributes;
  },
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  if (tracer === undefined) {
    return fn(NOOP_SPAN);
  }
  const span = tracer.startSpan(name, options);
  try {
    const result = await fn(span);
    span.setStatus({ code: "ok" });
    return result;
  } catch (error) {
    span.setStatus({
      code: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}

const NOOP_SPAN: SpanLike = {
  setAttribute() {
    return undefined;
  },
  setStatus() {
    return undefined;
  },
  end() {},
};

/** Wall-clock milliseconds for duration histograms. */
export function now(): number {
  return performance.now();
}

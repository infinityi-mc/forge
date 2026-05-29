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
  UpDownCounterLike,
} from "./types";

const NOOP_COUNTER: CounterLike = { add() {} };
const NOOP_HISTOGRAM: HistogramLike = { record() {} };
const NOOP_UPDOWN_COUNTER: UpDownCounterLike = { add() {} };

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
  /** Duplicate deliveries suppressed by an `InboxStore`. */
  readonly deduped: CounterLike;
  /** Current dead-letter depth (incremented as messages are parked). */
  readonly deadLetterSize: UpDownCounterLike;
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
      deduped: NOOP_COUNTER,
      deadLetterSize: NOOP_UPDOWN_COUNTER,
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
    deduped: meter.createCounter("messaging.inbox.deduped", {
      description: "Duplicate deliveries suppressed by the inbox store",
    }),
    // Up-down counters are optional on `MeterLike`; fall back to a no-op
    // so meters that predate the instrument still work.
    deadLetterSize:
      meter.createUpDownCounter?.("messaging.deadletter.size", {
        description: "Messages currently parked in the dead-letter store",
      }) ?? NOOP_UPDOWN_COUNTER,
  };
}

/** Metric instruments for an {@link createOutboxRelay} instance. */
export interface OutboxMetrics {
  /** Rows successfully forwarded to the bus. */
  readonly dispatched: CounterLike;
  /** Current relay backlog (undispatched rows). */
  readonly pending: UpDownCounterLike;
}

/** Build outbox-relay instruments; all no-op when no meter is present. */
export function createOutboxMetrics(
  telemetry?: MessagingTelemetry,
): OutboxMetrics {
  const meter = telemetry?.meter;
  if (meter === undefined) {
    return { dispatched: NOOP_COUNTER, pending: NOOP_UPDOWN_COUNTER };
  }
  return {
    dispatched: meter.createCounter("messaging.outbox.dispatched", {
      description: "Outbox rows forwarded to the bus",
    }),
    pending:
      meter.createUpDownCounter?.("messaging.outbox.pending", {
        description: "Outbox rows awaiting dispatch",
      }) ?? NOOP_UPDOWN_COUNTER,
  };
}

/** Metric instruments for a {@link createJobQueue} / {@link createWorker}. */
export interface JobMetrics {
  readonly enqueued: CounterLike;
  readonly completed: CounterLike;
  readonly failed: CounterLike;
}

/** Build background-job instruments; all no-op when no meter is present. */
export function createJobMetrics(telemetry?: MessagingTelemetry): JobMetrics {
  const meter = telemetry?.meter;
  if (meter === undefined) {
    return {
      enqueued: NOOP_COUNTER,
      completed: NOOP_COUNTER,
      failed: NOOP_COUNTER,
    };
  }
  return {
    enqueued: meter.createCounter("messaging.jobs.enqueued", {
      description: "Jobs added to the queue",
    }),
    completed: meter.createCounter("messaging.jobs.completed", {
      description: "Jobs that ran to completion",
    }),
    failed: meter.createCounter("messaging.jobs.failed", {
      description: "Jobs that exhausted their retries",
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

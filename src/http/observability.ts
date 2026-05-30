/**
 * Structural observability handles for `forge/http`.
 *
 * Like `data`/`config`/`messaging`, the HTTP module never hard-imports
 * `forge/telemetry`. Instead it accepts **structurally typed** handles —
 * a {@link MeterLike}, a {@link TracerLike}, and a {@link Logger} — and
 * emits signals only when a handle is injected, and nothing otherwise.
 * The real `forge/telemetry` `Meter`/`Tracer`/`Logger` satisfy these
 * shapes, so users pass the real objects without any adapter, and the
 * module stays free of a peer dependency.
 *
 * @module
 */

/** Attribute bag accepted by metric instruments (OTel-shaped). */
export type MetricAttributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/** Attribute bag accepted by spans (OTel-shaped). */
export type SpanAttributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/** A monotonic counter (e.g. request totals). Drops negative deltas. */
export interface CounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}

/**
 * A bi-directional counter (e.g. in-flight requests, queue depth). Unlike
 * {@link CounterLike} it accepts negative deltas, so `add(-1)` decrements.
 */
export interface UpDownCounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}

/** A distribution instrument (e.g. request duration). */
export interface HistogramLike {
  record(value: number, attributes?: MetricAttributes): void;
}

/**
 * The slice of a telemetry `Meter` the client needs. The real
 * `forge/telemetry/meter` `Meter` is assignable to this.
 */
export interface MeterLike {
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): CounterLike;
  createUpDownCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): UpDownCounterLike;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): HistogramLike;
}

/** Span kinds, matching the OTel/`forge/telemetry` vocabulary. */
export type SpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/** The slice of a telemetry `Span` consumed here (and by `tracedFetch`). */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setAttributes(attributes: SpanAttributes): unknown;
  setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
  addEvent(name: string, attributes?: SpanAttributes): unknown;
  end(endTime?: Date): void;
}

/**
 * The slice of a telemetry `Tracer` the client needs. Declared with
 * method syntax (bivariant params) so the real `forge/telemetry` `Tracer`
 * is assignable here **and** this is assignable back to `tracedFetch`'s
 * `Tracer` parameter — letting the client reuse `tracedFetch` verbatim.
 */
export interface TracerLike {
  startSpan(name: string, options?: { kind?: SpanKind; attributes?: SpanAttributes }): SpanLike;
  withSpan<T>(
    name: string,
    fn: (span: SpanLike) => T,
    options?: { kind?: SpanKind; attributes?: SpanAttributes },
  ): T;
}

/**
 * Opt-in telemetry handle. When `tracer` is present the client wraps its
 * `fetch` with `tracedFetch` (client span + W3C `traceparent` injection);
 * when `meter` is present it records `http.client.*` instruments.
 */
export interface HttpTelemetry {
  readonly meter?: MeterLike;
  readonly tracer?: TracerLike;
}

/**
 * Structural logger, matching `forge/telemetry/log`'s `Logger`. Only the
 * methods used are required; `child()` is optional.
 */
export interface Logger {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
  child?(attributes: Record<string, unknown>): Logger;
}

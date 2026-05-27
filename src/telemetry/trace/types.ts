/**
 * Types for `forge/telemetry/trace`.
 *
 * Shape matches the OpenTelemetry data model so OTLP export requires no
 * mapping step.
 *
 * @module
 */

import type { Resource } from "../types";

/**
 * Span kind mirrors the OTel spec. `internal` is the default.
 */
export type SpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/**
 * Span status code. `unset` means no status has been recorded;
 * `ok` marks the span as successful; `error` marks a failure. Once a
 * span is set to `ok` it cannot be overridden to `error` (match OTel
 * behaviour).
 */
export type SpanStatusCode = "unset" | "ok" | "error";

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string;
}

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: Date;
  readonly attributes?: SpanAttributes;
}

export interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes?: SpanAttributes;
  readonly traceFlags?: number;
}

/**
 * Read-only view of a finished span.
 */
export interface ReadableSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags: number;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly status: SpanStatus;
  readonly attributes: SpanAttributes;
  readonly events: readonly SpanEvent[];
  readonly links: readonly SpanLink[];
  readonly resource: Resource;
}

/**
 * Active span handle consumers interact with. Created by
 * `tracer.startSpan()` or `tracer.withSpan()`.
 */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): Span;
  setAttributes(attributes: SpanAttributes): Span;
  setStatus(status: SpanStatus): Span;
  addEvent(name: string, attributes?: SpanAttributes): Span;
  addLink(link: SpanLink): Span;
  /** End the span. Call exactly once. */
  end(endTime?: Date): void;
  readonly isRecording: boolean;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: SpanAttributes;
  links?: readonly SpanLink[];
  startTime?: Date;
  /**
   * Force a fresh root trace instead of becoming a child of the
   * current context.
   */
  root?: boolean;
}

/**
 * Sampling result returned by a {@link Sampler}.
 */
export type SamplingDecision =
  | "drop"
  | "record_only"
  | "record_and_sampled";

export interface SamplingResult {
  decision: SamplingDecision;
  attributes?: SpanAttributes;
}

/**
 * Determines whether a span is recorded/sampled. Runs before the span
 * is started so it can also inject extra attributes.
 */
export interface Sampler {
  shouldSample(
    parentTraceId: string | undefined,
    parentSpanId: string | undefined,
    parentTraceFlags: number | undefined,
    name: string,
    kind: SpanKind,
    attributes: SpanAttributes,
    links: readonly SpanLink[],
  ): SamplingResult;
  description: string;
}

/**
 * Processor for finished spans. Exporters are fed by processors.
 */
export interface SpanProcessor {
  onStart(span: Span): void;
  onEnd(span: ReadableSpan): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/**
 * Final sink for completed spans.
 */
export interface SpanExporter {
  export(spans: readonly ReadableSpan[]): Promise<void> | void;
  flush?(options?: { signal?: AbortSignal }): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface TracerOptions {
  resource: Resource;
  sampler?: Sampler;
  processor: SpanProcessor;
  /** Override the clock source for tests. */
  now?: () => Date;
}

export interface Tracer {
  /**
   * Start a new span. The span is automatically linked to the current
   * context unless `options.root` is set.
   */
  startSpan(name: string, options?: SpanOptions): Span;
  /**
   * Run `fn` inside a new span. The span is set as the current context
   * for the duration of `fn` and ended automatically when `fn` returns
   * (or throws). Returns `fn`'s return value.
   */
  withSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
}

export type CreateTracer = (options: TracerOptions) => Tracer;

export interface SpanBatch {
  readonly resource: Resource;
  readonly spans: readonly ReadableSpan[];
}

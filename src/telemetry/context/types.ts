/**
 * Types for `forge/telemetry/context`.
 *
 * @module
 */

/**
 * W3C trace-flags bit layout. Currently only bit 0 (`SAMPLED`) is defined.
 */
export const TRACE_FLAGS = {
  /** No flags set — span is not sampled. */
  NONE: 0x00,
  /** Bit 0: the recipient SHOULD record this trace. */
  SAMPLED: 0x01,
} as const;

/**
 * Per-flow telemetry context — trace identifiers and baggage that follow
 * a unit of work through async boundaries via `AsyncLocalStorage`.
 *
 * Every field except `traceId` and `spanId` is optional so a freshly
 * extracted context from a `traceparent` header is valid even when no
 * baggage is present.
 */
export interface TelemetryContext {
  /** 16-byte (32 hex char) trace identifier. Lower-case hex. */
  readonly traceId: string;
  /** 8-byte (16 hex char) span identifier. Lower-case hex. */
  readonly spanId: string;
  /** Parent span id, if this context was forked from a parent span. */
  readonly parentId?: string;
  /** W3C trace flags. Bit 0 = `SAMPLED`. */
  readonly traceFlags: number;
  /**
   * Cross-cutting key/value pairs propagated alongside the trace ids.
   * Values are always strings per the W3C baggage spec.
   */
  readonly baggage: Readonly<Record<string, string>>;
  /**
   * Opaque vendor-specific trace state from the `tracestate` header.
   * Preserved verbatim; we do not parse or validate vendor entries.
   */
  readonly traceState?: string;
}

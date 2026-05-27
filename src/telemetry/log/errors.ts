/**
 * Typed error taxonomy for `forge/telemetry/log`.
 *
 * Middleware and exporters throw one of these (or a subclass) instead
 * of bare `Error`s so consumers can branch with `instanceof` to
 * implement transport-agnostic recovery.
 *
 * @module
 */

import { TelemetryError } from "../errors";
import type { LogRecord } from "./types";

/**
 * Base class for every error thrown by `forge/telemetry/log`. Subclassed
 * by more specific errors; use this when no more specific category fits
 * or when an `instanceof LogError` check should catch the whole family.
 */
export class LogError extends TelemetryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogError";
  }
}

/**
 * An exporter failed while writing a record. The offending record is
 * preserved on `record` so telemetry middleware can surface what was
 * lost. The original error is preserved on `cause`.
 */
export class LogExporterError extends LogError {
  /** The record that was being written when the exporter failed. */
  readonly record?: LogRecord;

  constructor(message: string, options?: ErrorOptions & { record?: LogRecord }) {
    super(message, options);
    this.name = "LogExporterError";
    if (options?.record !== undefined) {
      this.record = options.record;
    }
  }
}

/**
 * A value in `attributes` could not be serialized (e.g. throwing
 * `toJSON`, a recursive structure that exceeded depth limits, or an
 * unsupported type).
 *
 * `path` is the dotted attribute path that failed, when known.
 */
export class LogSerializationError extends LogError {
  readonly path?: string;

  constructor(message: string, options?: ErrorOptions & { path?: string }) {
    super(message, options);
    this.name = "LogSerializationError";
    if (options?.path !== undefined) {
      this.path = options.path;
    }
  }
}

/**
 * A middleware dropped a record because the configured client-side
 * rate limit was exceeded.
 */
export class LogRateLimitError extends LogError {
  /** Milliseconds until the next token would become available. */
  readonly retryAfterMs: number;

  constructor(
    message: string,
    options: ErrorOptions & { retryAfterMs: number },
  ) {
    super(message, options);
    this.name = "LogRateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * A logger operation was aborted — typically while flushing an
 * async exporter against an `AbortSignal`.
 */
export class LogAbortError extends LogError {
  constructor(message = "log operation aborted", options?: ErrorOptions) {
    super(message, options);
    this.name = "LogAbortError";
  }
}

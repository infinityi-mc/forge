/**
 * Types for `forge/telemetry/log`.
 *
 * @module
 */

import type { TelemetryContext } from "../context/types";

/**
 * Log severity levels. Ordered low-to-high; `trace` is the noisiest,
 * `fatal` is the most severe.
 */
export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

/**
 * Structured attributes attached to a log record. Values may be any
 * JSON-serializable shape (errors, dates, nested objects). Middleware is
 * responsible for transforming non-JSON-friendly values into something
 * exporters can serialize (see `serialize` middleware).
 */
export type LogAttributes = Record<string, unknown>;

/**
 * A single log event emitted by the logger.
 *
 * `context` is auto-filled from `forge/telemetry/context` if a context
 * is active when the record is created — consumers do not pass it
 * explicitly.
 */
export interface LogRecord {
  /** Severity. */
  readonly level: LogLevel;
  /** Human-readable message. Should be a static string — put data in `attributes`. */
  readonly message: string;
  /** Wall-clock time the record was produced. */
  readonly timestamp: Date;
  /** Structured per-record attributes merged with the logger's base attributes. */
  readonly attributes: LogAttributes;
  /** Active telemetry context at emission time, if any. */
  readonly context?: TelemetryContext;
}

/**
 * Final sink for a {@link LogRecord}. Implementations write the record
 * to stdout, an HTTP collector, a queue, or anywhere else.
 *
 * Consumers either pick a built-in exporter (`stdoutExporter`,
 * `nullExporter`) or implement this interface themselves. Either way,
 * the contract is identical.
 */
export interface LogExporter {
  /** Synchronously hand the record to the exporter. May queue internally. */
  export(record: LogRecord): void;
  /**
   * Drain any pending records. Optional — exporters that write
   * synchronously can omit this.
   */
  flush?(options?: LogFlushOptions): Promise<void>;
  /**
   * Release exporter resources. Optional — usually a final `flush()`
   * is enough.
   */
  shutdown?(): Promise<void>;
}

export interface LogFlushOptions {
  signal?: AbortSignal;
}

/**
 * Wrap an exporter with additional behavior (redaction, rate limiting,
 * telemetry-of-telemetry, …). Composes as `[a, b, c]` → `a(b(c(exporter)))`,
 * so `a.export` sees the record first and the underlying exporter sees
 * it last.
 */
export type LogMiddleware = (next: LogExporter) => LogExporter;

/**
 * Options for {@link createLog}.
 */
export interface LogOptions {
  /** Minimum severity to emit. Defaults to `"info"`. */
  level?: LogLevel;
  /** Base attributes merged into every record this logger emits. */
  attributes?: LogAttributes;
  /** Where records are sent. */
  exporter: LogExporter;
  /**
   * Middleware applied outermost-first at construction time. Child
   * loggers reuse the already-wrapped exporter — middleware does not
   * re-stack per `child()` call.
   */
  middleware?: readonly LogMiddleware[];
  /**
   * Propagate exporter write failures to the caller. Defaults to
   * `false`: failures are isolated and reported via the stderr
   * fallback (or telemetry middleware, if installed).
   */
  propagateExporterErrors?: boolean;
}

/**
 * The logger surface consumers interact with. A `Logger` is the return
 * value of {@link createLog} and {@link Logger.child}.
 */
export interface Logger {
  trace(message: string, attributes?: LogAttributes): void;
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
  fatal(message: string, attributes?: LogAttributes): void;
  /**
   * Drain pending records on the underlying exporter. Resolves
   * immediately when the exporter has no queue.
   */
  flush?(options?: LogFlushOptions): Promise<void>;
  /**
   * Release the underlying exporter's resources (network connections,
   * file handles, …). Delegates to the wrapped exporter's `shutdown()`
   * so consumer-supplied middleware that overrides `shutdown` is
   * honored. Resolves immediately when the exporter has no
   * `shutdown` method. Optional so consumer-built loggers stay
   * backwards-compatible.
   */
  shutdown?(): Promise<void>;
  /**
   * Create a child logger with additional base attributes. The child
   * inherits the parent's level, exporter, and middleware stack.
   */
  child(attributes: LogAttributes): Logger;
}

/**
 * Factory function signature for creating loggers.
 */
export type CreateLog = (options: LogOptions) => Logger;

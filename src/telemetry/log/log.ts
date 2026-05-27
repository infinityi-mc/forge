/**
 * `createLog` — the entry point for `forge/telemetry/log`.
 *
 * Construction-time responsibilities:
 * - Compose middleware around the consumer-provided exporter.
 * - Cache the wrapped exporter so child loggers don't re-stack middleware.
 *
 * Per-record responsibilities:
 * - Filter by minimum level.
 * - Merge base + per-call attributes.
 * - Auto-inject the active `TelemetryContext` from `AsyncLocalStorage`.
 * - Isolate exporter throws so they never crash the caller.
 *
 * @module
 */

import { currentContext } from "../context/storage";
import { LogExporterError } from "./errors";
import { forwardHooks, isErrorHandled } from "./middleware/hooks";
import { serializeError } from "./serialize";
import type {
  CreateLog,
  LogAttributes,
  LogExporter,
  LogLevel,
  LogMiddleware,
  LogOptions,
  LogRecord,
  Logger,
} from "./types";

const LEVEL_ORDER: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

function shouldLog(entryLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(entryLevel) >= LEVEL_ORDER.indexOf(minLevel);
}

/**
 * Compose middleware around an exporter, outermost-first. `[a, b, c]`
 * produces `a(b(c(exporter)))`. We preserve `flush`/`shutdown` and the
 * internal drop/error hooks from the underlying exporter when the
 * middleware doesn't override them — this is what lets a `telemetry()`
 * middleware deep in the chain still observe `sample()` drops even
 * when a non-hook-aware middleware (`rateLimit`, `redact`, …) sits
 * between them.
 */
function applyMiddleware(
  exporter: LogExporter,
  middleware: readonly LogMiddleware[] | undefined,
): LogExporter {
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
    forwardHooks(wrapped, inner);
  }
  return wrapped;
}

function mergeAttributes(
  base: LogAttributes,
  extra?: LogAttributes,
): LogAttributes {
  if (!extra || Object.keys(extra).length === 0) return base;
  if (Object.keys(base).length === 0) return extra;
  return { ...base, ...extra };
}

function createLoggerInstance(
  level: LogLevel,
  baseAttributes: LogAttributes,
  exporter: LogExporter,
  propagateExporterErrors: boolean,
): Logger {
  const emit = (
    entryLevel: LogLevel,
    message: string,
    extra?: LogAttributes,
  ): void => {
    if (!shouldLog(entryLevel, level)) return;

    const record: LogRecord = {
      level: entryLevel,
      message,
      timestamp: new Date(),
      attributes: mergeAttributes(baseAttributes, extra),
      ...maybeContext(),
    };

    try {
      exporter.export(record);
    } catch (error) {
      if (propagateExporterErrors) throw error;
      if (!isErrorHandled(error)) writeExporterFailureFallback(error, record);
    }
  };

  return {
    trace: (message, attributes) => emit("trace", message, attributes),
    debug: (message, attributes) => emit("debug", message, attributes),
    info: (message, attributes) => emit("info", message, attributes),
    warn: (message, attributes) => emit("warn", message, attributes),
    error: (message, attributes) => emit("error", message, attributes),
    fatal: (message, attributes) => emit("fatal", message, attributes),
    flush: (options) => exporter.flush?.(options) ?? Promise.resolve(),
    shutdown: () => exporter.shutdown?.() ?? Promise.resolve(),
    child: (childAttributes) =>
      createLoggerInstance(
        level,
        mergeAttributes(baseAttributes, childAttributes),
        exporter,
        propagateExporterErrors,
      ),
  };
}

function maybeContext(): { context?: LogRecord["context"] } {
  const ctx = currentContext();
  return ctx ? { context: ctx } : {};
}

function writeExporterFailureFallback(error: unknown, record: LogRecord): void {
  const wrapped =
    error instanceof LogExporterError
      ? error
      : new LogExporterError("log exporter failed", { cause: error, record });
  const fallback = {
    level: "error",
    msg: "log exporter failed",
    err: serializeError(wrapped),
  };
  try {
    process.stderr.write(`${JSON.stringify(fallback)}\n`);
  } catch {
    // Last-resort fallback failed; do not make logging crash the caller.
  }
}

/**
 * Create a new logger.
 *
 * @example
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({ exporter: stdoutExporter() });
 * log.info("server started", { port: 3000 });
 *
 * const authLog = log.child({ subsystem: "auth" });
 * authLog.info("user login", { userId: "123" });
 * ```
 */
export const createLog: CreateLog = (options: LogOptions): Logger => {
  const {
    level = "info",
    attributes = {},
    exporter,
    middleware,
    propagateExporterErrors = false,
  } = options;

  const wrapped = applyMiddleware(exporter, middleware);
  return createLoggerInstance(level, attributes, wrapped, propagateExporterErrors);
};

/**
 * Structured logging for `forge/telemetry`.
 *
 * The library defines the logging contract — consumers supply the
 * exporter (where records go and how they're encoded). Built-in
 * exporters ship under `forge/telemetry/log/exporters/*` and built-in
 * middleware under `forge/telemetry/log/middleware`.
 *
 * @example Minimal usage
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({ exporter: stdoutExporter() });
 * log.info("server started", { port: 3000 });
 * ```
 *
 * @example Child loggers + middleware
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { redact } from "forge/telemetry/log/middleware";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({
 *   exporter: stdoutExporter(),
 *   middleware: [redact({ paths: ["user.password"] })],
 * });
 * const authLog = log.child({ subsystem: "auth" });
 * authLog.warn("repeated failure", { user: { id: 1, password: "shh" } });
 * ```
 *
 * @module
 */

export { createLog } from "./log";
export { serializeError } from "./serialize";
export type {
  CreateLog,
  LogAttributes,
  LogExporter,
  LogFlushOptions,
  LogLevel,
  LogMiddleware,
  LogOptions,
  LogRecord,
  Logger,
} from "./types";

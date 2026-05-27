/**
 * Built-in middleware for `forge/telemetry/log`.
 *
 * Substitutability is preserved: every middleware is just a function
 * `(next: LogExporter) => LogExporter`, so consumer-written middleware
 * plugs into the same pipeline.
 *
 * @example
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import {
 *   correlation,
 *   rateLimit,
 *   redact,
 *   sample,
 *   serialize,
 *   telemetry,
 * } from "forge/telemetry/log/middleware";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({
 *   exporter: stdoutExporter(),
 *   middleware: [
 *     redact({ paths: ["password"], patterns: [/Bearer\s+\S+/g] }),
 *     correlation(),
 *     serialize(),
 *     sample({ perSeverity: { debug: 0.1 } }),
 *     rateLimit({ recordsPerInterval: 1000, intervalMs: 60_000 }),
 *     telemetry({ onDrop: ({ reason }) => metrics.inc(`log.drop.${reason}`) }),
 *   ],
 * });
 * ```
 *
 * @module
 */

export type { LogMiddleware } from "../types";
export { correlation } from "./correlation";
export type { CorrelationOptions } from "./correlation";
export { rateLimit } from "./rate-limit";
export type {
  LogRateLimitOptions,
  LogRateLimitWhenExceeded,
} from "./rate-limit";
export { redact } from "./redact";
export type { RedactOptions } from "./redact";
export { sample } from "./sample";
export type { SampleOptions } from "./sample";
export { serialize } from "./serialize";
export type { SerializeOptions } from "./serialize";
export { telemetry } from "./telemetry";
export type { LogTelemetryHooks } from "./telemetry";

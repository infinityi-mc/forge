/**
 * Stdout exporter for `forge/telemetry/log` — writes log records to
 * `process.stdout` (and `process.stderr` for warn/error/fatal) in
 * either JSON-per-line or human-readable pretty form.
 *
 * @module
 */

export { stdoutExporter } from "./transport";
export type { StdoutExporterOptions } from "./transport";
export { formatJson } from "./format-json";
export type { JsonFormatOptions } from "./format-json";
export { formatPretty } from "./format-pretty";
export type { PrettyFormatOptions } from "./format-pretty";

/**
 * OTLP/HTTP JSON exporters for logs, metrics, and traces.
 *
 * @example
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { otlpHttpLogExporter } from "forge/telemetry/exporters/otlp-http";
 *
 * const log = createLog({
 *   exporter: otlpHttpLogExporter({
 *     url: "https://collector.example.com/v1/logs",
 *     headers: { "x-api-key": process.env.OTEL_API_KEY! },
 *     resource: { serviceName: "api", environment: "production" },
 *   }),
 * });
 * ```
 *
 * @module
 */

export { otlpHttpLogExporter, type OtlpHttpLogExporterOptions } from "./log";
export {
  otlpHttpMeterExporter,
  type OtlpHttpMeterExporterOptions,
} from "./meter";
export {
  otlpHttpTraceExporter,
  type OtlpHttpTraceExporterOptions,
} from "./trace";
export {
  createOtlpHttpClient,
  OtlpHttpError,
  type OtlpHttpClientOptions,
} from "./transport";

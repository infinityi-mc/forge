/**
 * Telemetry module — unified observability for `forge`-based applications.
 *
 * The module is divided into four internal subsystems imported via
 * subpaths so consumers pay only for what they use:
 *
 * - `forge/telemetry/context` — `AsyncLocalStorage`-backed context
 *   propagation (trace id, span id, baggage). The foundation every other
 *   subsystem builds on.
 * - `forge/telemetry/log` — structured, contextual JSON logging. **Shipped
 *   in this PR.**
 * - `forge/telemetry/meter` — counters, gauges, histograms with automatic
 *   aggregation. (Future PR.)
 * - `forge/telemetry/trace` — distributed tracing with W3C trace context
 *   propagation. (Future PR.)
 *
 * The top-level entry re-exports the cross-signal types so consumers can
 * write `import type { Resource, TelemetryError } from "forge/telemetry"`.
 *
 * @example Create a logger with the shipped subset
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({ exporter: stdoutExporter() });
 * log.info("server started", { port: 3000 });
 * ```
 *
 * @module
 */

export { TelemetryError } from "./errors";
export type { Resource } from "./types";

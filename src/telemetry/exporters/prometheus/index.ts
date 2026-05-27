/**
 * Prometheus text-exposition exporter for `forge/telemetry/meter`.
 *
 * @module
 */

export { formatPrometheus, sanitizeName } from "./format";
export {
  prometheusMeterExporter,
  type PrometheusMeterExporter,
} from "./exporter";

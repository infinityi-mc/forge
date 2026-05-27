/**
 * Prometheus scrape exporter for `forge/telemetry/meter`.
 *
 * Unlike OTLP this is *pull-based*: the exporter keeps the latest
 * batch in memory and exposes a `render()` method that the consumer
 * mounts on an HTTP scrape endpoint (typically `/metrics`).
 *
 * @example
 * ```ts
 * import Bun from "bun";
 * import { createMeter } from "forge/telemetry/meter";
 * import { prometheusMeterExporter } from "forge/telemetry/exporters/prometheus";
 *
 * const exporter = prometheusMeterExporter();
 * const meter = createMeter({
 *   resource: { serviceName: "api" },
 *   exporter,
 *   intervalMs: 1_000, // refresh the snapshot every second
 * });
 *
 * Bun.serve({
 *   port: 9100,
 *   async fetch(req) {
 *     if (new URL(req.url).pathname === "/metrics") {
 *       return new Response(exporter.render(), {
 *         headers: { "content-type": "text/plain; version=0.0.4" },
 *       });
 *     }
 *     return new Response("not found", { status: 404 });
 *   },
 * });
 * ```
 *
 * @module
 */

import type { MeterExporter, MetricBatch } from "../../meter/types";
import { formatPrometheus } from "./format";

export interface PrometheusMeterExporter extends MeterExporter {
  /** Latest exposition text. Empty until the first batch arrives. */
  render(): string;
  /** Latest in-memory batch, or `undefined` before the first collect. */
  latest(): MetricBatch | undefined;
}

export function prometheusMeterExporter(): PrometheusMeterExporter {
  let latestBatch: MetricBatch | undefined;
  let cachedText = "";

  return {
    export(batch) {
      latestBatch = batch;
      cachedText = formatPrometheus(batch);
    },
    render() {
      return cachedText;
    },
    latest() {
      return latestBatch;
    },
    async flush() {},
    async shutdown() {},
  };
}

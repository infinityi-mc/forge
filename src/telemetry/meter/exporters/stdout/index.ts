/**
 * Stdout exporter for `forge/telemetry/meter` — writes each metric
 * batch as a single JSON object per line to `process.stdout`.
 *
 * @module
 */

import type { MeterExporter, MetricBatch } from "../../types";

export interface StdoutMeterExporterOptions {
  stdout?: { write(chunk: string): unknown };
}

export function stdoutMeterExporter(
  options: StdoutMeterExporterOptions = {},
): MeterExporter {
  const out = options.stdout ?? process.stdout;
  return {
    export(batch: MetricBatch) {
      const payload = {
        resource: batch.resource,
        collectedAt: batch.collectedAt.toISOString(),
        metrics: batch.metrics.map((m) => ({
          ...m,
          points: m.points.map((p) => ({
            ...p,
            startTime: p.startTime.toISOString(),
            time: p.time.toISOString(),
          })),
        })),
      };
      out.write(`${JSON.stringify(payload)}\n`);
    },
  };
}

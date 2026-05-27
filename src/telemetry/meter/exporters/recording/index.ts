/**
 * Recording exporter for `forge/telemetry/meter` — keeps every batch
 * in memory. Test-only.
 *
 * @module
 */

import type { MeterExporter, MetricBatch } from "../../types";

export interface RecordingMeterExporter extends MeterExporter {
  readonly batches: readonly MetricBatch[];
  reset(): void;
}

export interface RecordingMeterExporterOptions {
  failNextWith?: (batch: MetricBatch) => Error | undefined;
  onFlush?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}

export function recordingMeterExporter(
  options: RecordingMeterExporterOptions = {},
): RecordingMeterExporter {
  const batches: MetricBatch[] = [];
  let failNext = options.failNextWith;

  return {
    batches,
    export(batch) {
      if (failNext) {
        const err = failNext(batch);
        failNext = undefined;
        if (err) throw err;
      }
      batches.push(batch);
    },
    async flush() {
      await options.onFlush?.();
    },
    async shutdown() {
      await options.onShutdown?.();
    },
    reset() {
      batches.length = 0;
      failNext = options.failNextWith;
    },
  };
}

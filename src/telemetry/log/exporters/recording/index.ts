/**
 * Recording exporter — keeps every record in memory and exposes them
 * for inspection. Primary use case is unit tests; production code
 * should never wire this exporter into a long-running logger.
 *
 * @module
 */

import type { LogExporter, LogRecord } from "../../types";

export interface RecordingExporter extends LogExporter {
  /** Records observed so far, in arrival order. */
  readonly records: readonly LogRecord[];
  /** Reset the buffer. */
  reset(): void;
}

export interface RecordingExporterOptions {
  /**
   * Throw the supplied error on the next `export()` call, then
   * automatically clear so subsequent writes succeed. Useful for
   * exercising error-isolation paths in tests.
   */
  failNextWith?: (record: LogRecord) => Error | undefined;
  /** Optional resolved value for `flush()`. */
  onFlush?: () => Promise<void> | void;
  /** Optional resolved value for `shutdown()`. */
  onShutdown?: () => Promise<void> | void;
}

export function recordingExporter(
  options: RecordingExporterOptions = {},
): RecordingExporter {
  const records: LogRecord[] = [];
  let failNext = options.failNextWith;

  return {
    records,
    export(record) {
      if (failNext) {
        const err = failNext(record);
        failNext = undefined;
        if (err) throw err;
      }
      records.push(record);
    },
    async flush() {
      await options.onFlush?.();
    },
    async shutdown() {
      await options.onShutdown?.();
    },
    reset() {
      records.length = 0;
      failNext = options.failNextWith;
    },
  };
}

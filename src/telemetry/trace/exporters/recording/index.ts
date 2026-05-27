/**
 * Recording span exporter — keeps every span in memory. Test-only.
 *
 * @module
 */

import type { ReadableSpan, SpanExporter } from "../../types";

export interface RecordingSpanExporter extends SpanExporter {
  readonly spans: readonly ReadableSpan[];
  reset(): void;
}

export interface RecordingSpanExporterOptions {
  failNextWith?: (batch: readonly ReadableSpan[]) => Error | undefined;
  onFlush?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}

export function recordingSpanExporter(
  options: RecordingSpanExporterOptions = {},
): RecordingSpanExporter {
  const spans: ReadableSpan[] = [];
  let failNext = options.failNextWith;

  return {
    spans,
    export(batch) {
      if (failNext) {
        const err = failNext(batch);
        failNext = undefined;
        if (err) throw err;
      }
      for (const s of batch) spans.push(s);
    },
    async flush() {
      await options.onFlush?.();
    },
    async shutdown() {
      await options.onShutdown?.();
    },
    reset() {
      spans.length = 0;
      failNext = options.failNextWith;
    },
  };
}

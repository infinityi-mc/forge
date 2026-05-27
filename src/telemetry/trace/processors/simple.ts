/**
 * Simple span processor — exports each span synchronously on `onEnd`.
 *
 * Useful for tests, scripts, and ultra-low-volume traces. Not
 * recommended for production HTTP workloads: every span triggers an
 * export call.
 *
 * @module
 */

import { serializeError } from "../../log/serialize";
import { SpanExporterError } from "../errors";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "../types";

export interface SimpleSpanProcessorOptions {
  exporter: SpanExporter;
  /** Propagate exporter throws. Defaults to `false`. */
  propagateExporterErrors?: boolean;
}

export function simpleSpanProcessor(
  options: SimpleSpanProcessorOptions,
): SpanProcessor {
  const { exporter, propagateExporterErrors = false } = options;

  return {
    onStart(_span: Span) {},
    onEnd(span: ReadableSpan) {
      try {
        const maybe = exporter.export([span]);
        if (maybe && typeof (maybe as Promise<void>).then === "function") {
          // `onEnd` is synchronous and has already returned by the time
          // an async export rejects, so we cannot bubble the error to
          // a caller without creating an unhandled rejection. The
          // `propagateExporterErrors` flag therefore only applies to
          // synchronous throws (the outer catch); async failures are
          // always routed to stderr.
          (maybe as Promise<void>).catch((err) => writeFallback(err, [span]));
        }
      } catch (err) {
        if (propagateExporterErrors) throw err;
        writeFallback(err, [span]);
      }
    },
    async shutdown() {
      await exporter.shutdown?.();
    },
    async forceFlush() {
      await exporter.flush?.();
    },
  };
}

function writeFallback(err: unknown, spans: readonly ReadableSpan[]): void {
  const wrapped =
    err instanceof SpanExporterError
      ? err
      : new SpanExporterError("span exporter failed", { cause: err, spans });
  const fallback = {
    level: "error",
    msg: "span exporter failed",
    err: serializeError(wrapped),
  };
  try {
    process.stderr.write(`${JSON.stringify(fallback)}\n`);
  } catch {
    // last-resort
  }
}

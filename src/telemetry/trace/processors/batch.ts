/**
 * Batch span processor — accumulates spans in a bounded queue and
 * flushes when either `maxQueueSize` or `scheduledDelayMs` is reached.
 *
 * This is the recommended processor for production HTTP/gRPC
 * workloads — it amortizes the wire cost across many spans.
 *
 * @module
 */

import { serializeError } from "../../log/serialize";
import { SpanExporterError } from "../errors";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "../types";

export interface BatchSpanProcessorOptions {
  exporter: SpanExporter;
  /** Maximum spans buffered before forcing an export. Defaults to 2048. */
  maxQueueSize?: number;
  /** Maximum spans per export batch. Defaults to 512. */
  maxExportBatchSize?: number;
  /** Delay (ms) between automatic export attempts. Defaults to 5000. */
  scheduledDelayMs?: number;
  /** Wait (ms) before considering an export hung. Defaults to 30_000. */
  exportTimeoutMs?: number;
  /** Propagate exporter throws. Defaults to `false`. */
  propagateExporterErrors?: boolean;
}

export function batchSpanProcessor(
  options: BatchSpanProcessorOptions,
): SpanProcessor {
  const {
    exporter,
    maxQueueSize = 2048,
    maxExportBatchSize = 512,
    scheduledDelayMs = 5000,
    exportTimeoutMs = 30_000,
    propagateExporterErrors = false,
  } = options;

  const queue: ReadableSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let activeFlush: Promise<void> | undefined;

  function schedule(): void {
    if (timer !== undefined || shuttingDown) return;
    timer = setTimeout(() => {
      timer = undefined;
      drain().catch(() => {});
    }, scheduledDelayMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  async function exportBatch(batch: ReadableSpan[]): Promise<void> {
    if (batch.length === 0) return;
    const exportPromise = Promise.resolve(exporter.export(batch));
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("export timeout")), exportTimeoutMs).unref?.(),
    );
    try {
      await Promise.race([exportPromise, timeout]);
    } catch (err) {
      if (propagateExporterErrors) throw err;
      writeFallback(err, batch);
    }
  }

  async function drain(): Promise<void> {
    if (activeFlush) {
      await activeFlush;
      return;
    }
    activeFlush = (async () => {
      while (queue.length > 0) {
        const batch = queue.splice(0, maxExportBatchSize);
        await exportBatch(batch);
      }
    })();
    try {
      await activeFlush;
    } finally {
      activeFlush = undefined;
    }
  }

  return {
    onStart(_span: Span) {},
    onEnd(span: ReadableSpan) {
      if (shuttingDown) return;
      if (queue.length >= maxQueueSize) {
        // Drop the oldest to bound memory.
        queue.shift();
      }
      queue.push(span);
      if (queue.length >= maxExportBatchSize) {
        drain().catch(() => {});
      } else {
        schedule();
      }
    },
    async forceFlush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
      await exporter.flush?.();
    },
    async shutdown() {
      shuttingDown = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
      await exporter.shutdown?.();
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

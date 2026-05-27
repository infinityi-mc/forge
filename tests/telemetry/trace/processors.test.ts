import { describe, expect, test } from "bun:test";
import {
  batchSpanProcessor,
  createTracer,
  simpleSpanProcessor,
} from "../../../src/telemetry/trace";
import { recordingSpanExporter } from "../../../src/telemetry/trace/testing";

const resource = { serviceName: "test" };

describe("simpleSpanProcessor", () => {
  test("exports each span individually", () => {
    const exporter = recordingSpanExporter();
    const tracer = createTracer({
      resource,
      processor: simpleSpanProcessor({ exporter }),
    });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    expect(exporter.spans).toHaveLength(2);
  });

  test("exporter errors do not crash the caller", () => {
    let calls = 0;
    const exporter = recordingSpanExporter({
      failNextWith: () => {
        calls += 1;
        return calls === 1 ? new Error("boom") : undefined;
      },
    });
    const tracer = createTracer({
      resource,
      processor: simpleSpanProcessor({ exporter }),
    });
    expect(() => tracer.startSpan("a").end()).not.toThrow();
    expect(() => tracer.startSpan("b").end()).not.toThrow();
  });
});

describe("batchSpanProcessor", () => {
  test("flushes the queue on forceFlush", async () => {
    const exporter = recordingSpanExporter();
    const processor = batchSpanProcessor({
      exporter,
      maxExportBatchSize: 10,
      scheduledDelayMs: 60_000,
    });
    const tracer = createTracer({ resource, processor });
    for (let i = 0; i < 5; i++) tracer.startSpan(`s${i}`).end();
    expect(exporter.spans).toHaveLength(0);
    await processor.forceFlush?.();
    expect(exporter.spans).toHaveLength(5);
    await processor.shutdown();
  });

  test("auto-flushes when batch size is reached", async () => {
    const exporter = recordingSpanExporter();
    const processor = batchSpanProcessor({
      exporter,
      maxExportBatchSize: 3,
      scheduledDelayMs: 60_000,
    });
    const tracer = createTracer({ resource, processor });
    for (let i = 0; i < 3; i++) tracer.startSpan(`s${i}`).end();
    // give the micro-task queue a chance to run
    await new Promise((r) => setImmediate(r));
    expect(exporter.spans.length).toBeGreaterThanOrEqual(3);
    await processor.shutdown();
  });

  test("shutdown drains pending spans", async () => {
    const exporter = recordingSpanExporter();
    const processor = batchSpanProcessor({
      exporter,
      maxExportBatchSize: 100,
      scheduledDelayMs: 60_000,
    });
    const tracer = createTracer({ resource, processor });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    await processor.shutdown();
    expect(exporter.spans).toHaveLength(2);
  });

  test("drops oldest spans when queue is full", async () => {
    const exporter = recordingSpanExporter();
    const processor = batchSpanProcessor({
      exporter,
      maxQueueSize: 2,
      maxExportBatchSize: 100,
      scheduledDelayMs: 60_000,
    });
    const tracer = createTracer({ resource, processor });
    for (const name of ["a", "b", "c"]) tracer.startSpan(name).end();
    await processor.forceFlush?.();
    const names = exporter.spans.map((s) => s.name);
    expect(names).toEqual(["b", "c"]);
    await processor.shutdown();
  });
});

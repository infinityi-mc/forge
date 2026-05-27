import { describe, expect, test } from "bun:test";
import { initTelemetry } from "../../../src/telemetry";
import { recordingExporter } from "../../../src/telemetry/log/exporters/recording";
import { recordingMeterExporter } from "../../../src/telemetry/meter/exporters/recording";
import { recordingSpanExporter } from "../../../src/telemetry/trace/exporters/recording";
import { createTestTelemetry } from "../../../src/telemetry/testing";

const resource = { serviceName: "init-test" };

describe("initTelemetry", () => {
  test("wires log + meter + trace independently", async () => {
    const logExp = recordingExporter();
    const meterExp = recordingMeterExporter();
    const spanExp = recordingSpanExporter();

    const t = initTelemetry({
      resource,
      log: { exporter: logExp, level: "debug" },
      meter: { exporter: meterExp, intervalMs: 0 },
      trace: { exporter: spanExp, processor: "simple" },
    });

    t.log!.info("ready");
    const counter = t.meter!.createCounter("c");
    counter.add(2);
    await t.meter!.collect();
    t.tracer!.startSpan("op").end();

    expect(logExp.records).toHaveLength(1);
    expect(meterExp.batches).toHaveLength(1);
    expect(spanExp.spans).toHaveLength(1);

    await t.shutdown();
  });

  test("each signal is independently optional", () => {
    const meterExp = recordingMeterExporter();
    const t = initTelemetry({
      resource,
      meter: { exporter: meterExp, intervalMs: 0 },
    });
    expect(t.log).toBeUndefined();
    expect(t.tracer).toBeUndefined();
    expect(t.meter).toBeDefined();
  });

  test("trace processor: 'batch' is the default", async () => {
    const spanExp = recordingSpanExporter();
    const t = initTelemetry({
      resource,
      trace: { exporter: spanExp }, // no processor
    });
    t.tracer!.startSpan("op").end();
    // Batch processor doesn't flush immediately — assert via forceFlush.
    expect(spanExp.spans).toHaveLength(0);
    await t.flush();
    expect(spanExp.spans).toHaveLength(1);
    await t.shutdown();
  });

  test("trace processor: 'simple' flushes synchronously on span.end()", () => {
    const spanExp = recordingSpanExporter();
    const t = initTelemetry({
      resource,
      trace: { exporter: spanExp, processor: "simple" },
    });
    t.tracer!.startSpan("op").end();
    expect(spanExp.spans).toHaveLength(1);
  });

  test("trace processor: rich batch options are forwarded", async () => {
    const spanExp = recordingSpanExporter();
    const t = initTelemetry({
      resource,
      trace: {
        exporter: spanExp,
        processor: {
          kind: "batch",
          maxQueueSize: 4,
          maxExportBatchSize: 2,
          scheduledDelayMs: 0,
        },
      },
    });
    for (let i = 0; i < 3; i++) t.tracer!.startSpan(`op-${i}`).end();
    await t.flush();
    expect(spanExp.spans).toHaveLength(3);
    await t.shutdown();
  });

  test("flush() aggregates per-signal results without throwing", async () => {
    const logExp = recordingExporter({
      onFlush() {
        throw new Error("log boom");
      },
    });
    const t = initTelemetry({
      resource,
      log: { exporter: logExp },
    });
    const result = await t.flush();
    expect(result.log).toEqual({ ok: false, error: expect.any(Error) });
  });

  test("shutdown() aggregates per-signal results without throwing", async () => {
    const meterExp = recordingMeterExporter({
      onShutdown() {
        throw new Error("meter boom");
      },
    });
    const t = initTelemetry({
      resource,
      meter: { exporter: meterExp, intervalMs: 0 },
    });
    const result = await t.shutdown();
    expect(result.meter).toEqual({ ok: false, error: expect.any(Error) });
  });

  test("shutdown() invokes the log exporter's shutdown (not just flush)", async () => {
    // Regression: pre-fix the log signal path only called
    // `logger.flush()`, so LogExporter.shutdown() — used by the OTLP
    // exporter to release its HTTP transport — was never invoked.
    let flushCalls = 0;
    let shutdownCalls = 0;
    const logExp = recordingExporter({
      onFlush: () => {
        flushCalls++;
      },
      onShutdown: () => {
        shutdownCalls++;
      },
    });
    const t = initTelemetry({
      resource,
      log: { exporter: logExp },
    });
    const result = await t.shutdown();
    expect(result.log).toEqual({ ok: true });
    expect(flushCalls).toBe(1);
    expect(shutdownCalls).toBe(1);
  });

  test("shutdown() reports failure when log shutdown throws", async () => {
    const logExp = recordingExporter({
      onShutdown: () => {
        throw new Error("log shutdown boom");
      },
    });
    const t = initTelemetry({
      resource,
      log: { exporter: logExp },
    });
    const result = await t.shutdown();
    expect(result.log).toEqual({ ok: false, error: expect.any(Error) });
  });
});

describe("createTestTelemetry", () => {
  test("exposes recording exporters and convenience getters", async () => {
    const t = createTestTelemetry();
    t.log!.info("hi", { user: "alice" });
    t.meter!.createCounter("c").add(1);
    await t.flushAll();
    t.tracer!.startSpan("op").end();

    expect(t.records).toHaveLength(1);
    expect(t.records[0]!.message).toBe("hi");
    expect(t.batches).toHaveLength(1);
    expect(t.spans).toHaveLength(1);
  });

  test("reset() clears every buffer", async () => {
    const t = createTestTelemetry();
    t.log!.info("hi");
    t.meter!.createCounter("c").add(1);
    await t.flushAll();
    t.tracer!.startSpan("op").end();

    t.reset();
    expect(t.records).toHaveLength(0);
    expect(t.batches).toHaveLength(0);
    expect(t.spans).toHaveLength(0);
  });

  test("disable flags omit a signal entirely", () => {
    const t = createTestTelemetry({ disableTrace: true });
    expect(t.tracer).toBeUndefined();
    expect(t.spanExporter).toBeUndefined();
    expect(t.log).toBeDefined();
  });

  test("trace uses the simple processor so spans appear immediately", () => {
    const t = createTestTelemetry();
    t.tracer!.startSpan("op").end();
    expect(t.spans).toHaveLength(1);
  });
});

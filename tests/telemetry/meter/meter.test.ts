import { describe, expect, test } from "bun:test";
import { createMeter } from "../../../src/telemetry/meter";
import type {
  HistogramPoint,
  MetricData,
  NumberPoint,
} from "../../../src/telemetry/meter";
import { recordingMeterExporter } from "../../../src/telemetry/meter/testing";

const resource = { serviceName: "test" };

function lastBatch(exp: ReturnType<typeof recordingMeterExporter>) {
  return exp.batches[exp.batches.length - 1]!;
}

describe("createMeter — counter", () => {
  test("aggregates adds per attribute set", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const requests = meter.createCounter("http.requests");
    requests.add(2, { method: "GET" });
    requests.add(3, { method: "GET" });
    requests.add(5, { method: "POST" });

    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & { kind: "counter" };
    const byMethod = new Map(m.points.map((p) => [p.attributes["method"], p.value]));
    expect(byMethod.get("GET")).toBe(5);
    expect(byMethod.get("POST")).toBe(5);
    expect(m.monotonic).toBe(true);
  });

  test("rejects negative deltas on monotonic counter", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const c = meter.createCounter("x");
    c.add(5);
    c.add(-3); // ignored
    c.add(NaN); // ignored

    await meter.collect();
    await meter.shutdown();

    const points = (lastBatch(exp).metrics[0]!.points) as readonly NumberPoint[];
    expect(points[0]!.value).toBe(5);
  });

  test("delta temporality resets counter between collections", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({
      resource,
      exporter: exp,
      intervalMs: 0,
      temporality: "delta",
    });
    const c = meter.createCounter("x");
    c.add(2);
    await meter.collect();
    c.add(3);
    await meter.collect();
    await meter.shutdown();

    const values = exp.batches.map(
      (b) => (b.metrics[0]!.points[0] as NumberPoint).value,
    );
    expect(values).toEqual([2, 3, 0]);
  });
});

describe("createMeter — up-down counter", () => {
  test("accepts negative deltas", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const inflight = meter.createUpDownCounter("inflight");
    inflight.add(5);
    inflight.add(-2);

    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & {
      kind: "up-down-counter";
    };
    expect(m.monotonic).toBe(false);
    expect(m.points[0]!.value).toBe(3);
  });
});

describe("createMeter — gauge", () => {
  test("reports the last recorded value", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const temp = meter.createGauge("temp.c");
    temp.record(21);
    temp.record(23);
    temp.record(22);

    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & { kind: "gauge" };
    expect(m.points[0]!.value).toBe(22);
  });
});

describe("createMeter — histogram", () => {
  test("aggregates count, sum, min, max, buckets", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const latency = meter.createHistogram("latency", {
      boundaries: [10, 50, 100],
    });
    for (const v of [5, 15, 50, 150]) latency.record(v);

    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & { kind: "histogram" };
    const p = m.points[0]! as HistogramPoint;
    expect(p.count).toBe(4);
    expect(p.sum).toBe(220);
    expect(p.min).toBe(5);
    expect(p.max).toBe(150);
    // boundaries [10, 50, 100] → buckets [<=10, <=50, <=100, +Inf] = [1, 2, 0, 1]
    expect(p.bucketCounts).toEqual([1, 2, 0, 1]);
  });

  test("sorts boundaries ascending", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const h = meter.createHistogram("x", { boundaries: [100, 10, 50] });
    h.record(15);
    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & { kind: "histogram" };
    expect(m.points[0]!.boundaries).toEqual([10, 50, 100]);
  });

  test("delta temporality preserves min/max across windows", async () => {
    // Regression: previously the delta reset set min/max to 0, so the
    // second window's all-positive values left min stuck at 0.
    const exp = recordingMeterExporter();
    const meter = createMeter({
      resource,
      exporter: exp,
      intervalMs: 0,
      temporality: "delta",
    });
    const h = meter.createHistogram("x", { boundaries: [10, 100] });
    h.record(5);
    h.record(50);
    await meter.collect();
    h.record(80);
    h.record(120);
    await meter.collect();
    await meter.shutdown();

    const second = exp.batches[1]!.metrics[0]!;
    const p = second.points[0] as HistogramPoint;
    expect(p.min).toBe(80);
    expect(p.max).toBe(120);
  });

  test("ignores NaN / non-finite values", async () => {
    const exp = recordingMeterExporter();
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    const h = meter.createHistogram("x");
    h.record(NaN);
    h.record(Infinity);
    h.record(10);
    await meter.collect();
    await meter.shutdown();

    const m = lastBatch(exp).metrics[0]! as MetricData & { kind: "histogram" };
    expect((m.points[0] as HistogramPoint).count).toBe(1);
  });
});

describe("createMeter — error isolation", () => {
  test("exporter throws do not crash the caller", async () => {
    const exp = recordingMeterExporter({
      failNextWith: () => new Error("boom"),
    });
    const meter = createMeter({ resource, exporter: exp, intervalMs: 0 });
    meter.createCounter("x").add(1);
    await expect(meter.collect()).resolves.toBeUndefined();
    await meter.shutdown();
  });

  test("propagates errors when propagateExporterErrors is true", async () => {
    const exp = recordingMeterExporter({
      failNextWith: () => new Error("boom"),
    });
    const meter = createMeter({
      resource,
      exporter: exp,
      intervalMs: 0,
      propagateExporterErrors: true,
    });
    meter.createCounter("x").add(1);
    await expect(meter.collect()).rejects.toThrow("boom");
    await meter.shutdown();
  });
});

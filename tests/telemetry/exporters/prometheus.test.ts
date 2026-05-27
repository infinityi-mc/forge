import { describe, expect, test } from "bun:test";
import { createMeter } from "../../../src/telemetry/meter";
import {
  formatPrometheus,
  prometheusMeterExporter,
  sanitizeName,
} from "../../../src/telemetry/exporters/prometheus";

const resource = { serviceName: "test" };

describe("sanitizeName", () => {
  test("replaces invalid characters", () => {
    expect(sanitizeName("http.requests.count")).toBe("http_requests_count");
  });
  test("prefixes leading digit with underscore", () => {
    expect(sanitizeName("404s")).toBe("_404s");
  });
  test("preserves colons and underscores", () => {
    expect(sanitizeName("svc:foo_bar")).toBe("svc:foo_bar");
  });
});

describe("formatPrometheus", () => {
  test("emits HELP, TYPE, and labelled samples for counter", async () => {
    const exporter = prometheusMeterExporter();
    const meter = createMeter({ resource, exporter, intervalMs: 0 });
    const c = meter.createCounter("http.requests", {
      description: "Total HTTP requests",
    });
    c.add(2, { method: "GET" });
    c.add(3, { method: "POST" });
    await meter.collect();
    await meter.shutdown();

    const text = exporter.render();
    expect(text).toContain("# HELP http_requests Total HTTP requests");
    expect(text).toContain("# TYPE http_requests counter");
    expect(text).toContain('http_requests{method="GET"} 2');
    expect(text).toContain('http_requests{method="POST"} 3');
  });

  test("up-down-counter is emitted as a gauge", async () => {
    const exporter = prometheusMeterExporter();
    const meter = createMeter({ resource, exporter, intervalMs: 0 });
    meter.createUpDownCounter("inflight").add(3);
    await meter.collect();
    await meter.shutdown();
    expect(exporter.render()).toContain("# TYPE inflight gauge");
  });

  test("histogram emits cumulative buckets, sum, count", async () => {
    const exporter = prometheusMeterExporter();
    const meter = createMeter({ resource, exporter, intervalMs: 0 });
    const h = meter.createHistogram("latency", { boundaries: [10, 50, 100] });
    for (const v of [5, 15, 50, 150]) h.record(v);
    await meter.collect();
    await meter.shutdown();

    const text = exporter.render();
    // boundaries [10, 50, 100] → buckets [<=10, <=50, <=100, +Inf]
    // counts [1, 2, 0, 1] → cumulative [1, 3, 3, 4]
    expect(text).toContain('latency_bucket{le="10"} 1');
    expect(text).toContain('latency_bucket{le="50"} 3');
    expect(text).toContain('latency_bucket{le="100"} 3');
    expect(text).toContain('latency_bucket{le="+Inf"} 4');
    expect(text).toContain("latency_sum 220");
    expect(text).toContain("latency_count 4");
  });

  test("escapes label values", async () => {
    const exporter = prometheusMeterExporter();
    const meter = createMeter({ resource, exporter, intervalMs: 0 });
    meter.createGauge("g").record(1, { path: 'foo"bar\\baz' });
    await meter.collect();
    await meter.shutdown();
    expect(exporter.render()).toContain('path="foo\\"bar\\\\baz"');
  });

  test("empty batch produces empty string", () => {
    expect(
      formatPrometheus({ resource, metrics: [], collectedAt: new Date() }),
    ).toBe("");
  });
});

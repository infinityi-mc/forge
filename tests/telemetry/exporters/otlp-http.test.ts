import { describe, expect, test } from "bun:test";
import { createLog } from "../../../src/telemetry/log";
import { createMeter } from "../../../src/telemetry/meter";
import { createTracer, simpleSpanProcessor } from "../../../src/telemetry/trace";
import {
  otlpHttpLogExporter,
  otlpHttpMeterExporter,
  otlpHttpTraceExporter,
  OtlpHttpError,
  createOtlpHttpClient,
} from "../../../src/telemetry/exporters/otlp-http";

const resource = { serviceName: "test", environment: "ci" };

interface Captured {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetch(opts: {
  status?: number;
  failTimes?: number;
  captured: Captured[];
} = { captured: [] }) {
  const status = opts.status ?? 200;
  let failed = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init?.headers && !(init.headers instanceof Headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    opts.captured.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers,
    });
    if (opts.failTimes && failed < opts.failTimes) {
      failed += 1;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status });
  };
  return fakeFetch;
}

describe("otlpHttpLogExporter", () => {
  test("POSTs an ExportLogsServiceRequest", async () => {
    const captured: Captured[] = [];
    const log = createLog({
      exporter: otlpHttpLogExporter({
        resource,
        fetch: makeFetch({ captured }),
        maxRetries: 0,
      }),
    });
    log.info("hi", { user: "alice" });
    await log.flush();

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as { resourceLogs: unknown[] };
    expect(body.resourceLogs).toHaveLength(1);
    const rec = (body.resourceLogs[0] as { scopeLogs: { logRecords: unknown[] }[] })
      .scopeLogs[0]!.logRecords[0] as {
      severityText: string;
      body: { stringValue: string };
    };
    expect(rec.severityText).toBe("INFO");
    expect(rec.body.stringValue).toBe("hi");
  });
});

describe("otlpHttpMeterExporter", () => {
  test("encodes counter + histogram correctly", async () => {
    const captured: Captured[] = [];
    const meter = createMeter({
      resource,
      exporter: otlpHttpMeterExporter({
        fetch: makeFetch({ captured }),
        maxRetries: 0,
      }),
      intervalMs: 0,
    });
    meter.createCounter("c").add(1);
    meter.createHistogram("h", { boundaries: [10] }).record(5);
    await meter.collect();
    await meter.shutdown();

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const body = captured[0]!.body as {
      resourceMetrics: { scopeMetrics: { metrics: unknown[] }[] }[];
    };
    const metrics = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics).toHaveLength(2);
    const counter = metrics[0] as { name: string; sum: { isMonotonic: boolean } };
    expect(counter.name).toBe("c");
    expect(counter.sum.isMonotonic).toBe(true);
    const histogram = metrics[1] as {
      name: string;
      histogram: { dataPoints: { bucketCounts: string[] }[] };
    };
    expect(histogram.name).toBe("h");
    expect(histogram.histogram.dataPoints[0]!.bucketCounts).toEqual(["1", "0"]);
  });
});

describe("otlpHttpTraceExporter", () => {
  test("encodes span hierarchy", async () => {
    const captured: Captured[] = [];
    const exporter = otlpHttpTraceExporter({
      fetch: makeFetch({ captured }),
      maxRetries: 0,
    });
    const tracer = createTracer({
      resource,
      processor: simpleSpanProcessor({ exporter, propagateExporterErrors: false }),
    });
    tracer.withSpan("parent", () => {
      tracer.withSpan("child", () => {});
    });
    // simple processor's export is fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const allSpans = captured.flatMap((c) => {
      const body = c.body as {
        resourceSpans: { scopeSpans: { spans: { name: string; parentSpanId?: string }[] }[] }[];
      };
      return body.resourceSpans[0]!.scopeSpans[0]!.spans;
    });
    const names = allSpans.map((s) => s.name).sort();
    expect(names).toEqual(["child", "parent"]);
  });
});

describe("createOtlpHttpClient", () => {
  test("retries on 503 then succeeds", async () => {
    const captured: Captured[] = [];
    const send = createOtlpHttpClient({
      url: "http://collector/v1/logs",
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetch: makeFetch({ captured, failTimes: 1 }),
    });
    await send("{}");
    expect(captured).toHaveLength(2);
  });

  test("throws OtlpHttpError on non-retriable 4xx", async () => {
    const captured: Captured[] = [];
    const send = createOtlpHttpClient({
      url: "http://collector/v1/logs",
      maxRetries: 3,
      retryBaseDelayMs: 1,
      fetch: makeFetch({ captured, status: 400 }),
    });
    await expect(send("{}")).rejects.toBeInstanceOf(OtlpHttpError);
    expect(captured).toHaveLength(1);
  });

  test("includes custom headers", async () => {
    const captured: Captured[] = [];
    const send = createOtlpHttpClient({
      url: "http://collector/v1/logs",
      maxRetries: 0,
      headers: { authorization: "Bearer t" },
      fetch: makeFetch({ captured }),
    });
    await send("{}");
    expect(captured[0]!.headers["authorization"]).toBe("Bearer t");
  });
});

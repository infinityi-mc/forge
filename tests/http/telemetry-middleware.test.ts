import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { testClient } from "../../src/http/testing";
import { telemetryMiddleware } from "../../src/http/middleware";
import { createTestTelemetry } from "../../src/telemetry/testing";

describe("telemetryMiddleware", () => {
  test("records a server span with route + status attributes", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(telemetryMiddleware({ telemetry: { tracer: telemetry.tracer } }))
      .get("/users/:id", () => new Response("ok"));
    await testClient(router).get("/users/7");
    await telemetry.flushAll();

    expect(telemetry.spans.length).toBe(1);
    const span = telemetry.spans[0]!;
    expect(span.kind).toBe("server");
    expect(span.attributes["http.route"]).toBe("/users/:id");
    expect(span.attributes["http.response.status_code"]).toBe(200);
  });

  test("continues an inbound traceparent into the server span", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(telemetryMiddleware({ telemetry: { tracer: telemetry.tracer } }))
      .get("/", () => new Response("ok"));
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    await testClient(router).get("/", {
      headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
    });
    await telemetry.flushAll();
    expect(telemetry.spans[0]?.traceId).toBe(traceId);
  });

  test("records http.server.request.duration with method/route/status", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(telemetryMiddleware({ telemetry: { meter: telemetry.meter } }))
      .get("/ping", () => new Response("ok"));
    await testClient(router).get("/ping");
    await telemetry.flushAll();

    const metrics = telemetry.batches.flatMap((b) => b.metrics);
    const duration = metrics.find(
      (m) => m.descriptor.name === "http.server.request.duration",
    );
    expect(duration).toBeDefined();
    const point = duration!.points[0]!;
    expect(point.attributes["http.request.method"]).toBe("GET");
    expect(point.attributes["http.route"]).toBe("/ping");
    expect(point.attributes["http.response.status_code"]).toBe(200);
  });

  test("marks a 5xx span as error", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(telemetryMiddleware({ telemetry: { tracer: telemetry.tracer } }))
      .get("/", () => new Response("boom", { status: 500 }));
    await testClient(router).get("/");
    await telemetry.flushAll();
    expect(telemetry.spans[0]?.status.code).toBe("error");
  });

  test("emits nothing when no telemetry handle is supplied", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(telemetryMiddleware())
      .get("/", () => new Response("ok"));
    await testClient(router).get("/");
    await telemetry.flushAll();
    expect(telemetry.spans.length).toBe(0);
  });
});

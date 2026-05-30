import { describe, expect, test } from "bun:test";
import { createHttpClient } from "../../src/http/client";
import { ProblemError, RequestError, TimeoutError } from "../../src/http/errors";
import { createMockServer, createTestHttp } from "../../src/http/testing";

describe("MockServer", () => {
  test("records requests and replies with a canned body", async () => {
    const mock = createMockServer();
    mock.on("GET", "/ping", { body: { ok: true } });
    const client = createHttpClient({ baseUrl: "https://svc.test", fetch: mock.fetch });

    await client.get("/ping");
    expect(mock.count).toBe(1);
    expect(mock.requests[0]!.method).toBe("GET");
    expect(mock.requests[0]!.url).toBe("https://svc.test/ping");
  });

  test("replies with an RFC 7807 problem", async () => {
    const mock = createMockServer();
    mock.on("POST", "/x", { problem: { status: 409, detail: "dup" } });
    const client = createHttpClient({ baseUrl: "https://svc.test", fetch: mock.fetch });

    const err = (await client.post("/x", {}).catch((e) => e)) as ProblemError;
    expect(err).toBeInstanceOf(ProblemError);
    expect(err.status).toBe(409);
  });

  test("simulates a transport failure", async () => {
    const mock = createMockServer();
    mock.on("GET", "/x", { error: "ECONNRESET" });
    const client = createHttpClient({ baseUrl: "https://svc.test", fetch: mock.fetch });

    const err = (await client.get("/x").catch((e) => e)) as RequestError;
    expect(err).toBeInstanceOf(RequestError);
  });

  test("latency honors the abort signal so a timeout fires", async () => {
    const mock = createMockServer();
    mock.on("GET", "/slow", { body: {}, latencyMs: 1_000 });
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch: mock.fetch,
      timeoutMs: 20,
    });

    const err = (await client.get("/slow").catch((e) => e)) as TimeoutError;
    expect(err).toBeInstanceOf(TimeoutError);
  });

  test("unmatched routes return 501", async () => {
    const mock = createMockServer();
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch: mock.fetch,
      throwOnError: false,
    });
    const res = await client.get("/nope");
    expect(res.status).toBe(501);
  });
});

describe("createTestHttp", () => {
  test("wires a mock, telemetry, and a pre-configured client", async () => {
    const http = createTestHttp({ baseUrl: "https://svc.test" });
    http.mock.on("GET", "/ping", { body: { ok: true } });

    const res = await http.client().get<{ ok: boolean }>("/ping");
    await http.telemetry.flushAll();

    expect(res.body.ok).toBe(true);
    // tracer was injected → exactly one client span
    expect(http.telemetry.spans.length).toBe(1);
    // meter was injected → a client duration metric recorded
    const metrics = http.telemetry.batches.flatMap((b) => b.metrics);
    expect(
      metrics.some((m) => m.descriptor.name === "http.client.request.duration"),
    ).toBe(true);
  });

  test("reset() clears mock + telemetry buffers", async () => {
    const http = createTestHttp({ baseUrl: "https://svc.test" });
    http.mock.on("GET", "/ping", { body: {} });
    await http.client().get("/ping");
    http.reset();
    expect(http.mock.count).toBe(0);
  });
});

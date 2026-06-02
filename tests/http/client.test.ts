import { describe, expect, test } from "bun:test";
import { createHttpClient } from "../../src/http/client";
import {
  ProblemError,
  RequestError,
  ResponseError,
  TimeoutError,
} from "../../src/http/errors";
import { createMockServer } from "../../src/http/testing";
import { createTestTelemetry } from "../../src/telemetry/testing";
import { combine, retry, timeout } from "../../src/resilience";
import type { FetchLike } from "../../src/http/types";

describe("createHttpClient — request shaping", () => {
  test("resolves relative paths against baseUrl, merges headers, decodes JSON", async () => {
    const mock = createMockServer();
    mock.on("GET", "/users/1", { body: { id: 1, name: "ada" } });
    const client = createHttpClient({
      baseUrl: "https://api.test",
      defaultHeaders: { "x-app": "forge", accept: "application/json" },
      fetch: mock.fetch,
    });

    const res = await client.get<{ id: number; name: string }>("/users/1", {
      headers: { accept: "application/vnd.custom" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, name: "ada" });
    const sent = mock.requests[0]!;
    expect(sent.url).toBe("https://api.test/users/1");
    expect(sent.headers.get("x-app")).toBe("forge");
    // per-request header overrides the default
    expect(sent.headers.get("accept")).toBe("application/vnd.custom");
  });

  test("encodes a JSON body and sets content-type", async () => {
    const mock = createMockServer();
    mock.on("POST", "/charges", { status: 201, body: { id: "ch_1" } });
    const client = createHttpClient({ baseUrl: "https://pay.test", fetch: mock.fetch });

    const res = await client.post<{ id: string }>("/charges", { amount: 999 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("ch_1");
    const sent = mock.requests[0]!;
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.body).toBe(JSON.stringify({ amount: 999 }));
  });

  test("appends query parameters", async () => {
    const mock = createMockServer();
    mock.on("GET", "/search", { body: [] });
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    await client.get("/search", { query: { q: "forge", page: 2, exact: true } });

    const url = new URL(mock.requests[0]!.url);
    expect(url.searchParams.get("q")).toBe("forge");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("exact")).toBe("true");
  });

  test("decodes an empty 204 body to undefined", async () => {
    const mock = createMockServer();
    mock.on("DELETE", "/users/1", { status: 204 });
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    const res = await client.delete("/users/1");
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
  });

  test("throws synchronously on a malformed baseUrl", () => {
    expect(() => createHttpClient({ baseUrl: "not a url" })).toThrow(RequestError);
  });

  test("throws synchronously when baseUrl protocol is not in allowedProtocols", () => {
    expect(() =>
      createHttpClient({ baseUrl: "https://api.test", allowedProtocols: ["http:"] }),
    ).toThrow(RequestError);
  });

  test("extend() inherits config and applies overrides", async () => {
    const mock = createMockServer();
    mock.on("GET", "/whoami", { body: { tenant: "acme" } });
    const base = createHttpClient({
      baseUrl: "https://api.test",
      defaultHeaders: { "x-tenant": "root" },
      fetch: mock.fetch,
    });
    const scoped = base.extend({ defaultHeaders: { "x-tenant": "acme" } });

    await scoped.get("/whoami");
    expect(mock.requests[0]!.headers.get("x-tenant")).toBe("acme");
  });
});

describe("createHttpClient — url policy (SSRF guard)", () => {
  test("rejects an absolute request url to another origin by default", async () => {
    const mock = createMockServer();
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    const error = (await client
      .get("https://evil.test/steal")
      .catch((e) => e)) as RequestError;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.message).toContain("baseUrl origin");
    expect(mock.count).toBe(0);
  });

  test("rejects a non-http(s) protocol by default", async () => {
    const mock = createMockServer();
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    const error = (await client
      .get("file:///etc/passwd")
      .catch((e) => e)) as RequestError;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.message).toContain("protocol");
    expect(mock.count).toBe(0);
  });

  test("allows an absolute same-origin url", async () => {
    const mock = createMockServer();
    mock.on("GET", "/users/1", { body: { id: 1 } });
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    const res = await client.get<{ id: number }>("https://api.test/users/1");
    expect(res.body.id).toBe(1);
  });

  test("allowAbsoluteUrls opt-in permits a cross-origin absolute url", async () => {
    const mock = createMockServer();
    mock.on("GET", "/steal", { body: { ok: true } });
    const client = createHttpClient({
      baseUrl: "https://api.test",
      allowAbsoluteUrls: true,
      fetch: mock.fetch,
    });

    const res = await client.get<{ ok: boolean }>("https://other.test/steal");
    expect(res.body.ok).toBe(true);
    expect(mock.requests[0]!.url).toBe("https://other.test/steal");
  });

  test("allowedHosts opt-in permits a named peer origin", async () => {
    const mock = createMockServer();
    mock.on("GET", "/health", { body: { ok: true } });
    const client = createHttpClient({
      baseUrl: "https://api.test",
      allowedHosts: ["peer.test"],
      fetch: mock.fetch,
    });

    const res = await client.get<{ ok: boolean }>("https://peer.test/health");
    expect(res.body.ok).toBe(true);
  });

  test("query appending still works after origin enforcement", async () => {
    const mock = createMockServer();
    mock.on("GET", "/search", { body: [] });
    const client = createHttpClient({ baseUrl: "https://api.test", fetch: mock.fetch });

    await client.get("/search", { query: { q: "forge" } });
    expect(new URL(mock.requests[0]!.url).searchParams.get("q")).toBe("forge");
  });
});

describe("createHttpClient — error handling", () => {
  test("parses application/problem+json into a typed ProblemError", async () => {
    const mock = createMockServer();
    mock.on("POST", "/charges", {
      problem: { status: 422, title: "Unprocessable", detail: "bad amount", code: "AMOUNT" },
    });
    const client = createHttpClient({ baseUrl: "https://pay.test", fetch: mock.fetch });

    const error = (await client.post("/charges", { amount: -1 }).catch((e) => e)) as ProblemError;
    expect(error).toBeInstanceOf(ProblemError);
    expect(error.status).toBe(422);
    expect(error.problem.detail).toBe("bad amount");
    expect(error.problem.code).toBe("AMOUNT");
  });

  test("throws ResponseError on a non-problem non-2xx", async () => {
    const mock = createMockServer();
    mock.on("GET", "/boom", { status: 500, body: { error: "boom" } });
    const client = createHttpClient({ baseUrl: "https://svc.test", fetch: mock.fetch });

    const error = (await client.get("/boom").catch((e) => e)) as ResponseError;
    expect(error).toBeInstanceOf(ResponseError);
    expect(error.status).toBe(500);
    expect(error.response).toBeInstanceOf(Response);
  });

  test("throwOnError:false resolves the non-2xx response instead of throwing", async () => {
    const mock = createMockServer();
    mock.on("GET", "/boom", { status: 503, body: { down: true } });
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch: mock.fetch,
      throwOnError: false,
    });

    const res = await client.get<{ down: boolean }>("/boom");
    expect(res.status).toBe(503);
    expect(res.body.down).toBe(true);
  });

  test("wraps transport failures in RequestError (cause preserved)", async () => {
    const boom = new Error("ECONNREFUSED");
    const fetch: FetchLike = () => Promise.reject(boom);
    const client = createHttpClient({ baseUrl: "https://svc.test", fetch });

    const error = (await client.get("/x").catch((e) => e)) as RequestError;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.cause).toBe(boom);
  });
});

describe("createHttpClient — timeout", () => {
  test("timeoutMs aborts the underlying fetch and throws TimeoutError", async () => {
    let observed: AbortSignal | undefined;
    const fetch: FetchLike = (_input, init) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    };
    const client = createHttpClient({ baseUrl: "https://svc.test", timeoutMs: 20, fetch });

    const error = (await client.get("/slow").catch((e) => e)) as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.timeoutMs).toBe(20);
    expect(observed?.aborted).toBe(true);
  });

  test("a fast response under the deadline succeeds", async () => {
    const mock = createMockServer();
    mock.on("GET", "/ok", { body: { ok: true }, latencyMs: 1 });
    const client = createHttpClient({ baseUrl: "https://svc.test", timeoutMs: 200, fetch: mock.fetch });

    const res = await client.get<{ ok: boolean }>("/ok");
    expect(res.body.ok).toBe(true);
  });
});

describe("createHttpClient — resilience composition", () => {
  test("retries transport failures through a resilience pipeline", async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error("transient"));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch,
      resilience: combine(retry({ maxAttempts: 3 })),
    });

    const res = await client.get<{ ok: boolean }>("/flaky");
    expect(res.body.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("passes the pipeline signal through so a resilience timeout cancels the socket", async () => {
    let observed: AbortSignal | undefined;
    const fetch: FetchLike = (_input, init) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    };
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch,
      resilience: combine(timeout({ ms: 20 })),
    });

    await client.get("/slow").catch((e) => e);
    expect(observed?.aborted).toBe(true);
  });
});

describe("createHttpClient — telemetry", () => {
  test("records http.client.request.duration when a meter is present", async () => {
    const mock = createMockServer();
    mock.on("GET", "/ping", { body: { ok: true } });
    const telemetry = createTestTelemetry();
    const client = createHttpClient({
      baseUrl: "https://svc.test",
      fetch: mock.fetch,
      telemetry: { meter: telemetry.meter },
    });

    await client.get("/ping");
    await telemetry.flushAll();

    const metrics = telemetry.batches.flatMap((b) => b.metrics);
    const duration = metrics.find(
      (m) => m.descriptor.name === "http.client.request.duration",
    );
    expect(duration).toBeDefined();
    const point = duration!.points[0]!;
    expect(point.attributes["http.request.method"]).toBe("GET");
    expect(point.attributes["http.response.status_code"]).toBe("200");
    expect(point.attributes["server.address"]).toBe("svc.test");
  });
});

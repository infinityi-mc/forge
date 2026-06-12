import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { testClient } from "../../src/http/testing";
import {
  accessLog,
  auth,
  bodyLimit,
  cors,
  problemDetails,
  rateLimit,
  requestId,
} from "../../src/http/middleware";
import { problem } from "../../src/http/problem";
import { ValidationError } from "../../src/http/errors";
import {
  combine,
  CircuitOpenError,
  rateLimit as resilienceRateLimit,
} from "../../src/resilience";
import { createTestTelemetry } from "../../src/telemetry/testing";

describe("requestId", () => {
  test("mints an id, exposes it on locals, and echoes it on the response", async () => {
    let seen: unknown;
    const router = createRouter()
      .use(requestId({ generate: () => "fixed-id" }))
      .get("/", (req) => {
        seen = req.locals.requestId;
        return new Response("ok");
      });
    const res = await testClient(router).get("/");
    expect(seen).toBe("fixed-id");
    expect(res.headers.get("x-request-id")).toBe("fixed-id");
  });

  test("propagates an inbound id", async () => {
    const router = createRouter()
      .use(requestId())
      .get("/", () => new Response("ok"));
    const res = await testClient(router).get("/", {
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });
});

describe("accessLog", () => {
  test("logs one structured line per request", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(accessLog({ logger: telemetry.log }))
      .get("/ping", () => new Response("ok"));
    await testClient(router).get("/ping");
    await telemetry.flushAll();
    expect(telemetry.records.length).toBe(1);
    expect(telemetry.records[0]?.attributes).toMatchObject({
      method: "GET",
      path: "/ping",
      status: 200,
    });
  });
});

describe("problemDetails", () => {
  test("renders a thrown ProblemError verbatim", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        throw problem.conflict("already exists", { code: "DUP" });
      });
    const res = await testClient(router).get("/");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 409, detail: "already exists", code: "DUP" });
  });

  test("maps ValidationError to 422", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        throw new ValidationError("bad input");
      });
    const res = await testClient(router).get("/");
    expect(res.status).toBe(422);
  });

  test("maps a structural RateLimitError to 429 + Retry-After", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        const err = new Error("slow down");
        err.name = "RateLimitError";
        (err as { retryAfterMs?: number }).retryAfterMs = 1500;
        throw err;
      });
    const res = await testClient(router).get("/");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
  });

  test("maps a structural CircuitOpenError to 503", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        const err = new Error("open");
        err.name = "CircuitOpenError";
        throw err;
      });
    expect((await testClient(router).get("/")).status).toBe(503);
  });

  test("maps structural CircuitOpenError retryAt to Retry-After", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        const err = new Error("open");
        err.name = "CircuitOpenError";
        (err as { retryAt?: number }).retryAt = Date.now() + 60_000;
        throw err;
      });
    const res = await testClient(router).get("/");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  test("omits CircuitOpenError Retry-After when retryAt is not in the future", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        const err = new Error("open");
        err.name = "CircuitOpenError";
        (err as { retryAt?: number }).retryAt = Date.now() - 1_000;
        throw err;
      });
    const res = await testClient(router).get("/");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  test("maps forge/resilience CircuitOpenError retryAt structurally", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/", () => {
        throw new CircuitOpenError("open", {
          state: "open",
          openedAt: Date.now(),
          retryAt: Date.now() + 60_000,
        });
      });
    const res = await testClient(router).get("/");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  test("defaults unmapped errors to a leak-free 500 and logs them", async () => {
    const telemetry = createTestTelemetry();
    const router = createRouter()
      .use(problemDetails({ logger: telemetry.log }))
      .get("/", () => {
        throw new Error("secret internals");
      });
    const res = await testClient(router).get("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBeUndefined();
    await telemetry.flushAll();
    expect(telemetry.records.some((l) => l.message.includes("unhandled error"))).toBe(true);
  });
});

describe("cors", () => {
  test("answers a preflight with 204 and the negotiated headers", async () => {
    const router = createRouter()
      .use(cors({ origin: "https://app.test", credentials: true, maxAge: 600 }))
      .post("/", () => new Response("ok"));
    const res = await testClient(router).fetch("/", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  test("echoes the request origin (not *) when credentials are enabled with origin '*'", async () => {
    const router = createRouter()
      .use(cors({ origin: "*", credentials: true }))
      .get("/", () => new Response("ok"));
    const res = await testClient(router).get("/", {
      headers: { origin: "https://app.test" },
    });
    // Per Fetch §3.2.5, ACAO must not be "*" alongside credentials.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("keeps '*' for origin '*' without credentials", async () => {
    const router = createRouter()
      .use(cors({ origin: "*" }))
      .get("/", () => new Response("ok"));
    const res = await testClient(router).get("/", {
      headers: { origin: "https://app.test" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("adds ACAO on a normal response and omits it for disallowed origins", async () => {
    const router = createRouter()
      .use(cors({ origin: ["https://app.test"] }))
      .get("/", () => new Response("ok"));
    const client = testClient(router);

    const allowed = await client.get("/", { headers: { origin: "https://app.test" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test");

    const denied = await client.get("/", { headers: { origin: "https://evil.test" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("bodyLimit", () => {
  test("rejects an oversized Content-Length with 413", async () => {
    const router = createRouter()
      .use(bodyLimit({ maxBytes: 8 }))
      .post("/", () => new Response("ok"));
    const res = await testClient(router).fetch("/", {
      method: "POST",
      headers: { "content-length": "1024" },
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  test("passes a within-limit request through", async () => {
    const router = createRouter()
      .use(bodyLimit({ maxBytes: 1024 }))
      .post("/", () => new Response("ok"));
    const res = await testClient(router).post("/", { a: 1 });
    expect(res.status).toBe(200);
  });

  test("caps a streaming body with no Content-Length at read time", async () => {
    const router = createRouter()
      .use(problemDetails())
      .use(bodyLimit({ maxBytes: 8 }))
      .post("/", async (req) => new Response(await req.text()));
    // A ReadableStream body is sent chunked — no Content-Length header — so it
    // slips past the header check and must be caught as bytes are read.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        controller.close();
      },
    });
    const res = await testClient(router).fetch("/", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  test("an under-reported Content-Length does not bypass the read-time cap", async () => {
    const router = createRouter()
      .use(problemDetails())
      .use(bodyLimit({ maxBytes: 8 }))
      .post("/", async (req) => new Response(await req.text()));
    const res = await testClient(router).fetch("/", {
      method: "POST",
      headers: { "content-length": "4" }, // lies: actual body is 1024 bytes
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
  });

  test("rejects a malformed Content-Length", async () => {
    const router = createRouter()
      .use(problemDetails())
      .use(bodyLimit({ maxBytes: 1024 }))
      .post("/", () => new Response("ok"));
    const res = await testClient(router).fetch("/", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "small",
    });
    expect(res.status).toBe(413);
  });
});

describe("rateLimit (structural seam)", () => {
  test("runs the handler through the injected limiter", async () => {
    let executed = 0;
    const limiter = {
      execute: async <T>(op: () => Promise<T> | T): Promise<T> => {
        executed += 1;
        return op();
      },
    };
    const router = createRouter()
      .use(rateLimit({ limiter }))
      .get("/", () => new Response("ok"));
    const res = await testClient(router).get("/");
    expect(res.status).toBe(200);
    expect(executed).toBe(1);
  });

  test("a limiter rejection surfaces (mapped by problemDetails)", async () => {
    const limiter = {
      execute: <T>(_op: () => Promise<T> | T): Promise<T> => {
        const err = new Error("limited");
        err.name = "RateLimitError";
        return Promise.reject(err);
      },
    };
    const router = createRouter()
      .use(problemDetails())
      .use(rateLimit({ limiter }))
      .get("/", () => new Response("ok"));
    expect((await testClient(router).get("/")).status).toBe(429);
  });

  test("maps forge/resilience RateLimitedError to 429", async () => {
    const limiter = combine(
      resilienceRateLimit({
        algorithm: { kind: "sliding-window", limit: 1, windowMs: 1_000 },
      }),
    );
    const router = createRouter()
      .use(problemDetails())
      .use(rateLimit({ limiter }))
      .get("/", () => new Response("ok"));
    const client = testClient(router);

    expect((await client.get("/")).status).toBe(200);
    const limited = await client.get("/");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
  });
});

describe("auth (structural seam)", () => {
  test("stores the principal on locals and continues", async () => {
    let principal: unknown;
    const router = createRouter()
      .use(auth({ verifier: () => ({ sub: "ada" }) }))
      .get("/", (req) => {
        principal = req.locals.principal;
        return new Response("ok");
      });
    await testClient(router).get("/");
    expect(principal).toEqual({ sub: "ada" });
  });

  test("a thrown verifier rejects the request via problemDetails", async () => {
    const router = createRouter()
      .use(problemDetails())
      .use(auth({ verifier: () => { throw problem.unauthorized("nope"); } }))
      .get("/", () => new Response("secret"));
    expect((await testClient(router).get("/")).status).toBe(401);
  });
});

/**
 * Client conformance scenarios for `forge/http`.
 *
 * {@link STANDARD_HTTP_SCENARIOS} pins the client-side invariants any
 * `HttpClient` (the stock {@link createHttpClient}, or a BYO wrapper) must
 * satisfy:
 *
 * - a `timeoutMs` aborts the underlying `fetch` signal and surfaces a
 *   `TimeoutError` (no leaked promise);
 * - `throwOnError` parses an RFC 7807 body into a typed `ProblemError`;
 * - a non-problem non-2xx throws `ResponseError`, and `throwOnError: false`
 *   resolves the response instead;
 * - the client injects an outbound `traceparent` when a tracer is present
 *   (reusing `tracedFetch`);
 * - the `problem.*` constructors carry the right status and render
 *   `application/problem+json`.
 *
 * Errors are plain `Error`s so the suite is framework-agnostic. Pass a
 * custom {@link HttpClientFactory} to {@link assertConformance} to validate
 * an alternative client; it defaults to {@link createHttpClient}.
 *
 * @module
 */

import { createHttpClient } from "../client";
import { ProblemError, ResponseError, RouteConflictError, TimeoutError } from "../errors";
import { problem } from "../problem";
import { PROBLEM_CONTENT_TYPE } from "../problem/render";
import { createRouter } from "../server";
import { problemDetails, telemetryMiddleware } from "../middleware";
import type { HttpClient, HttpClientOptions } from "../client/types";
import type { Middleware } from "../types";
import type { Router } from "../server/types";
import { createTestTelemetry } from "../../telemetry/testing";
import { createMockServer, testClient } from "./index";

/** The client constructor under test — `createHttpClient` by default. */
export type HttpClientFactory = (options?: HttpClientOptions) => HttpClient;

/** A single conformance scenario. `run` resolves on success or throws. */
export interface HttpConformanceScenario {
  name: string;
  run(factory: HttpClientFactory): Promise<void>;
}

export const STANDARD_HTTP_SCENARIOS: readonly HttpConformanceScenario[] = [
  {
    name: "timeoutMs aborts the underlying fetch and throws TimeoutError",
    async run(factory) {
      let abortedSignal: AbortSignal | undefined;
      const client = factory({
        baseUrl: "https://svc.test",
        timeoutMs: 10,
        fetch: (_input, init) => {
          abortedSignal = init?.signal ?? undefined;
          // Never resolves on its own; only the timeout can settle it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      });
      const error = await capture(() => client.get("/slow"));
      if (!(error instanceof TimeoutError)) {
        throw new Error(`expected TimeoutError, got ${describe(error)}`);
      }
      if (!abortedSignal?.aborted) {
        throw new Error("expected the underlying fetch signal to be aborted");
      }
    },
  },
  {
    name: "throwOnError parses an RFC 7807 body into a typed ProblemError",
    async run(factory) {
      const mock = createMockServer();
      mock.on("GET", "/charges", {
        problem: { status: 422, title: "Unprocessable", detail: "bad amount", code: "AMOUNT" },
      });
      const client = factory({ baseUrl: "https://pay.test", fetch: mock.fetch });
      const error = await capture(() => client.get("/charges"));
      if (!(error instanceof ProblemError)) {
        throw new Error(`expected ProblemError, got ${describe(error)}`);
      }
      if (error.status !== 422) {
        throw new Error(`expected status 422, got ${error.status}`);
      }
      if (error.problem.detail !== "bad amount" || error.problem.code !== "AMOUNT") {
        throw new Error("expected problem detail + extension members preserved");
      }
    },
  },
  {
    name: "non-problem non-2xx throws ResponseError; throwOnError:false resolves it",
    async run(factory) {
      const mock = createMockServer();
      mock.on("GET", "/x", { status: 500, body: { error: "boom" } });

      const throwing = factory({ baseUrl: "https://svc.test", fetch: mock.fetch });
      const error = await capture(() => throwing.get("/x"));
      if (!(error instanceof ResponseError) || error.status !== 500) {
        throw new Error(`expected ResponseError(500), got ${describe(error)}`);
      }

      const lenient = factory({
        baseUrl: "https://svc.test",
        fetch: mock.fetch,
        throwOnError: false,
      });
      const res = await lenient.get<{ error: string }>("/x");
      if (res.status !== 500 || res.body.error !== "boom") {
        throw new Error("expected throwOnError:false to resolve the 500 response");
      }
    },
  },
  {
    name: "client injects an outbound traceparent when a tracer is present",
    async run(factory) {
      const mock = createMockServer();
      mock.on("GET", "/ping", { body: { ok: true } });
      const telemetry = createTestTelemetry();
      const client = factory({
        baseUrl: "https://svc.test",
        fetch: mock.fetch,
        telemetry: { tracer: telemetry.tracer },
      });
      await client.get("/ping");
      await telemetry.flushAll();
      const sent = mock.requests[0]?.headers.get("traceparent");
      if (!sent) {
        throw new Error("expected an outbound traceparent header (via tracedFetch)");
      }
      if (telemetry.spans.length !== 1) {
        throw new Error(`expected exactly one client span, got ${telemetry.spans.length}`);
      }
    },
  },
  {
    name: "problem.* constructors carry the right status and render problem+json",
    async run() {
      const cases: ReadonlyArray<[ProblemError, number]> = [
        [problem.badRequest(), 400],
        [problem.unauthorized(), 401],
        [problem.forbidden(), 403],
        [problem.notFound(), 404],
        [problem.conflict(), 409],
        [problem.unprocessable(), 422],
        [problem.tooManyRequests(), 429],
        [problem.internal(), 500],
      ];
      for (const [err, status] of cases) {
        if (err.status !== status) {
          throw new Error(`expected status ${status}, got ${err.status}`);
        }
        const res = err.toResponse();
        if (res.status !== status) {
          throw new Error(`expected response status ${status}, got ${res.status}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes(PROBLEM_CONTENT_TYPE)) {
          throw new Error(`expected ${PROBLEM_CONTENT_TYPE}, got "${contentType}"`);
        }
      }
    },
  },
];

/**
 * Run the conformance scenarios against a client factory. Defaults to the
 * stock {@link createHttpClient}; pass your own to validate a wrapper.
 *
 * @example
 * ```ts
 * import { assertConformance } from "forge/http/testing";
 * await assertConformance();
 * ```
 */
export async function assertConformance(
  factory: HttpClientFactory = createHttpClient,
  scenarios: readonly HttpConformanceScenario[] = STANDARD_HTTP_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `http conformance: "${scenario.name}" failed — ${message}`,
        { cause: error },
      );
    }
  }
}

async function capture(op: () => Promise<unknown>): Promise<unknown> {
  try {
    await op();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw, but it resolved");
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.constructor.name}: ${value.message}`;
  return String(value);
}

// ---------------------------------------------------------------------------
// Server conformance
// ---------------------------------------------------------------------------

/** The router constructor under test — `createRouter` by default. */
export type RouterFactory = () => Router;

/** A single server conformance scenario. `run` resolves on success or throws. */
export interface ServerConformanceScenario {
  name: string;
  run(factory: RouterFactory): Promise<void>;
}

/**
 * Server-side invariants any `forge/http` server stack must satisfy:
 *
 * - middleware composes outermost-first and short-circuits (a middleware
 *   that returns without calling `next` wins);
 * - `problemDetails()` renders `application/problem+json` with the right
 *   status for both a thrown `ProblemError` and a mapped Forge error;
 * - an inbound `traceparent` is continued into the server span (same
 *   trace id, `server` kind);
 * - duplicate routes throw `RouteConflictError` at construction, not at
 *   request time.
 */
export const STANDARD_SERVER_SCENARIOS: readonly ServerConformanceScenario[] = [
  {
    name: "middleware composes outermost-first and short-circuits",
    async run(factory) {
      const order: string[] = [];
      const tag = (label: string): Middleware => (next) => async (req) => {
        order.push(`>${label}`);
        const res = await next(req);
        order.push(`<${label}`);
        return res;
      };
      const router = factory()
        .use(tag("a"))
        .use(tag("b"))
        .get("/", () => new Response("ok"));
      await testClient(router).get("/");
      if (order.join(",") !== ">a,>b,<b,<a") {
        throw new Error(`expected outermost-first order, got ${order.join(",")}`);
      }

      const shorted = factory()
        .use(() => () => new Response("blocked", { status: 403 }))
        .get("/", () => new Response("should not run"));
      const res = await testClient(shorted).get("/");
      if (res.status !== 403 || (await res.text()) !== "blocked") {
        throw new Error("expected the short-circuiting middleware to win");
      }
    },
  },
  {
    name: "problemDetails renders problem+json for ProblemError and mapped errors",
    async run(factory) {
      const router = factory()
        .use(problemDetails())
        .get("/explicit", () => {
          throw problem.notFound("missing");
        })
        .get("/rate", () => {
          // Structural RateLimitError (no hard forge/resilience import here).
          const err = new Error("slow down");
          err.name = "RateLimitError";
          (err as { retryAfterMs?: number }).retryAfterMs = 2000;
          throw err;
        })
        .get("/boom", () => {
          throw new Error("internal kaboom");
        });
      const client = testClient(router);

      const explicit = await client.get("/explicit");
      assertProblem(explicit, 404);

      const rate = await client.get("/rate");
      assertProblem(rate, 429);
      if (rate.headers.get("retry-after") !== "2") {
        throw new Error(`expected Retry-After: 2, got ${rate.headers.get("retry-after")}`);
      }

      const boom = await client.get("/boom");
      assertProblem(boom, 500);
      const body = (await boom.json()) as { detail?: string };
      if (body.detail !== undefined) {
        throw new Error("expected unmapped 500 to omit detail (no leak)");
      }
    },
  },
  {
    name: "inbound traceparent is continued into the server span",
    async run(factory) {
      const telemetry = createTestTelemetry();
      const router = factory()
        .use(telemetryMiddleware({ telemetry: { tracer: telemetry.tracer } }))
        .get("/ping", () => new Response("ok"));
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      await testClient(router).get("/ping", {
        headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
      });
      await telemetry.flushAll();
      const span = telemetry.spans[0];
      if (!span) throw new Error("expected a server span to be recorded");
      if (span.traceId !== traceId) {
        throw new Error(`expected span to continue trace ${traceId}, got ${span.traceId}`);
      }
      if (span.kind !== "server") {
        throw new Error(`expected a server-kind span, got ${span.kind}`);
      }
    },
  },
  {
    name: "duplicate routes throw RouteConflictError at construction",
    async run(factory) {
      const error = (() => {
        try {
          factory()
            .get("/dupe", () => new Response("a"))
            .get("/dupe", () => new Response("b"));
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      if (!(error instanceof RouteConflictError)) {
        throw new Error(`expected RouteConflictError, got ${describe(error)}`);
      }
    },
  },
];

/**
 * Run the server conformance scenarios against a router factory. Defaults
 * to the stock {@link createRouter}; pass your own to validate a wrapper.
 */
export async function assertServerConformance(
  factory: RouterFactory = createRouter,
  scenarios: readonly ServerConformanceScenario[] = STANDARD_SERVER_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `http server conformance: "${scenario.name}" failed — ${message}`,
        { cause: error },
      );
    }
  }
}

function assertProblem(res: Response, status: number): void {
  if (res.status !== status) {
    throw new Error(`expected status ${status}, got ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes(PROBLEM_CONTENT_TYPE)) {
    throw new Error(`expected ${PROBLEM_CONTENT_TYPE}, got "${contentType}"`);
  }
}

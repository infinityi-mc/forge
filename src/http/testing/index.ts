/**
 * `forge/http/testing` — doubles and harnesses for the HTTP edge.
 *
 * Testability is a first-class feature (Principle 2). PR A ships the
 * client-side doubles:
 *
 * - {@link MockServer} — a programmable fake for the *client* side:
 *   register canned responses / RFC 7807 errors / latency / transport
 *   failures by `method`+`path`, inject its `fetch` into
 *   `createHttpClient({ fetch })`, then assert against `mock.requests`.
 * - {@link createTestHttp} — a one-call harness bundling a `MockServer`,
 *   recording telemetry (`createTestTelemetry`), and a pre-wired client
 *   factory. (The in-process `testClient(router)` lands with the server
 *   in PR B.)
 * - {@link STANDARD_HTTP_SCENARIOS} + {@link assertConformance} — the
 *   framework-agnostic client conformance suite.
 *
 * @module
 */

import { createHttpClient } from "../client";
import type { HttpClient, HttpClientOptions } from "../client/types";
import { renderProblem } from "../problem/render";
import { createHttpRequest } from "../server/request";
import type { Router } from "../server/types";
import { createTestTelemetry } from "../../telemetry/testing";
import type { TestTelemetry } from "../../telemetry/testing";
import type { FetchLike, ProblemDetails } from "../types";

export {
  STANDARD_HTTP_SCENARIOS,
  assertConformance,
  type HttpClientFactory,
  type HttpConformanceScenario,
} from "./conformance";
export {
  STANDARD_SERVER_SCENARIOS,
  assertServerConformance,
  type RouterFactory,
  type ServerConformanceScenario,
} from "./conformance";

/**
 * Drives a {@link Router}'s handler **in-process** (no socket): build a
 * `Request`, get a `Response`. The fastest way to unit-test routes +
 * middleware. Relative paths resolve against `baseUrl` (default
 * `http://test.local`).
 */
export interface TestClient {
  /** Send a fully-formed request (path or `Request`). */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  delete(path: string, init?: RequestInit): Promise<Response>;
}

/** Build an in-process {@link TestClient} for `router`. */
export function testClient(
  router: Router,
  options: { baseUrl?: string } = {},
): TestClient {
  const baseUrl = options.baseUrl ?? "http://test.local";
  const handler = router.handler();

  const send = (input: string | Request, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request ? input : new Request(resolve(baseUrl, input), init);
    return Promise.resolve(handler(createHttpRequest(request)));
  };
  const withBody = (
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const hasBody = body !== undefined;
    const headers = new Headers(init?.headers);
    if (hasBody && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return send(path, {
      ...init,
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  };

  return {
    fetch: send,
    get: (path, init) => send(path, { ...init, method: "GET" }),
    post: (path, body, init) => withBody("POST", path, body, init),
    put: (path, body, init) => withBody("PUT", path, body, init),
    patch: (path, body, init) => withBody("PATCH", path, body, init),
    delete: (path, init) => send(path, { ...init, method: "DELETE" }),
  };
}

function resolve(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(path, baseUrl).toString();
}

/** A request observed by a {@link MockServer}, captured for assertions. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  /** Raw request body when it was a string (e.g. JSON); otherwise `undefined`. */
  readonly body: string | undefined;
}

/** How a {@link MockServer} should answer a matched request. */
export interface MockResponseSpec {
  /** Status code. Default `200`. */
  readonly status?: number;
  /** JSON-encoded response body. */
  readonly body?: unknown;
  /** Extra response headers. */
  readonly headers?: Record<string, string>;
  /** Reply with an RFC 7807 `application/problem+json` body (overrides `body`). */
  readonly problem?: Partial<ProblemDetails> & { status: number };
  /** Delay before responding; aborts (rejects) if the request's signal fires. */
  readonly latencyMs?: number;
  /** Simulate a transport failure by rejecting instead of responding. */
  readonly error?: Error | string;
}

/** A programmable fake downstream for testing the client. */
export interface MockServer {
  /** Register the response for `METHOD path` (path matched by pathname). */
  on(method: string, path: string, spec: MockResponseSpec): MockServer;
  /** The `fetch` to inject via `createHttpClient({ fetch: mock.fetch })`. */
  readonly fetch: FetchLike;
  /** Every request received so far, in order. */
  readonly requests: ReadonlyArray<RecordedRequest>;
  /** Number of requests received (convenience). */
  readonly count: number;
  /** Drop all registrations and recorded requests. */
  reset(): void;
}

/**
 * Create a programmable fake downstream. Unmatched requests resolve to a
 * `501` so a missing stub fails loudly rather than hanging.
 *
 * @example
 * ```ts
 * const mock = createMockServer();
 * mock.on("POST", "/charges", { status: 201, body: { id: "ch_1" } });
 * const api = createHttpClient({ baseUrl: "https://pay.test", fetch: mock.fetch });
 * await api.post("/charges", { amount: 999 });
 * expect(mock.requests[0]?.method).toBe("POST");
 * ```
 */
export function createMockServer(): MockServer {
  const routes = new Map<string, MockResponseSpec>();
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = inputUrl(input);
    const method = inputMethod(input, init);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, headers, body });

    const spec = routes.get(key(method, pathnameOf(url))) ?? routes.get(key(method, "*"));
    if (!spec) {
      return jsonResponse(501, { title: `no mock for ${method} ${url}` });
    }

    if (spec.latencyMs && spec.latencyMs > 0) {
      await sleep(spec.latencyMs, init?.signal ?? undefined);
    }
    if (spec.error !== undefined) {
      throw spec.error instanceof Error ? spec.error : new Error(spec.error);
    }
    if (spec.problem) {
      return renderProblem(spec.problem, { headers: spec.headers });
    }
    const responseHeaders = new Headers(spec.headers);
    let payload: string | undefined;
    if (spec.body !== undefined) {
      payload = JSON.stringify(spec.body);
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/json");
      }
    }
    return new Response(payload, { status: spec.status ?? 200, headers: responseHeaders });
  };

  const mock: MockServer = {
    on(method, path, spec) {
      routes.set(key(method.toUpperCase(), path), spec);
      return mock;
    },
    fetch: fetchImpl,
    get requests() {
      return requests;
    },
    get count() {
      return requests.length;
    },
    reset() {
      routes.clear();
      requests.length = 0;
    },
  };
  return mock;
}

/** A one-call test harness: mock downstream + recording telemetry + client. */
export interface TestHttp {
  /** The fake downstream injected into every client built by {@link client}. */
  readonly mock: MockServer;
  /** Recording telemetry (logs/metrics/spans) for assertions. */
  readonly telemetry: TestTelemetry;
  /** Build a client pre-wired to {@link mock} and {@link telemetry}. */
  client(overrides?: Partial<HttpClientOptions>): HttpClient;
  /** Reset the mock and telemetry buffers. */
  reset(): void;
}

/**
 * Wire a {@link MockServer}, recording telemetry, and a client factory in
 * one call — the HTTP analogue of `createTestTelemetry` /
 * `createTestResilience`.
 *
 * @example
 * ```ts
 * const http = createTestHttp();
 * http.mock.on("GET", "/ping", { body: { ok: true } });
 * const res = await http.client({ baseUrl: "https://svc.test" }).get("/ping");
 * await http.telemetry.flushAll();
 * ```
 */
export function createTestHttp(
  options: { baseUrl?: string } = {},
): TestHttp {
  const mock = createMockServer();
  const telemetry = createTestTelemetry();
  const harness: TestHttp = {
    mock,
    telemetry,
    client(overrides = {}) {
      return createHttpClient({
        baseUrl: options.baseUrl,
        fetch: mock.fetch,
        telemetry: { meter: telemetry.meter, tracer: telemetry.tracer },
        logger: telemetry.log,
        ...overrides,
      });
    },
    reset() {
      mock.reset();
      telemetry.reset();
    },
  };
  return harness;
}

function key(method: string, path: string): string {
  return `${method} ${path}`;
}

function inputUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function inputMethod(
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    const m = (input as { method?: string }).method;
    if (typeof m === "string") return m.toUpperCase();
  }
  return "GET";
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export { createMockServer as mockServer };

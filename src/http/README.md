# forge/http

The request/response **edge** of a Forge application. One module, two faces over the same primitives: a resilient, traced **client** for calling other services, and a thin typed **server** over `Bun.serve()`. Errors speak one machine-readable dialect — RFC 7807 _Problem Details_ — in both directions.

```ts
import { createHttpClient } from "forge/http/client";
import { combine, retry, timeout, exponentialBackoff } from "forge/resilience";

const api = createHttpClient({
  baseUrl: "https://payments.internal",
  timeoutMs: 2_000,
  resilience: combine(
    retry({ maxAttempts: 3, backoff: exponentialBackoff() }),
    timeout({ ms: 2_000 }),
  ),
  telemetry, // composes tracedFetch: client span + W3C traceparent
});

const { body } = await api.post<{ id: string }>("/charges", { amount: 999 });
```

Resilience and tracing are not bolted on per call site — they are **defaults by composition**. You pass a `forge/resilience` pipeline and/or a `forge/telemetry` tracer once, and every request inherits retries, timeouts that actually cancel the socket, client spans, and trace-context propagation. Downstream RFC 7807 error bodies come back as typed `ProblemError`s.

The module depends on nothing concrete: telemetry and resilience are **structural** (`MeterLike`, `TracerLike`, `Logger`, `PipelineLike`), so the real Forge objects drop in with no adapter and no peer dependency. The one util it reuses is `tracedFetch`, and only when a tracer is actually injected.

It is **not** a generic HTTP framework, a service mesh, or an RPC layer. It is the thin, observable, resilient edge — nothing more.

---

## Features

### Client

- **`createHttpClient(options)`** — a resilient, traced `fetch` wrapper exported from `forge/http` and `forge/http/client`. `request()` drives every verb (`get`/`post`/`put`/`patch`/`delete`); `extend()` returns a child with merged config.
  - Resolves relative paths against `baseUrl` (malformed `baseUrl` **throws at construction**), merges `defaultHeaders` (per-call headers win), applies `query`, and encodes the body via the Codec.
  - Arms a per-request `AbortSignal` from `timeoutMs`, combined with the caller's `signal` **and** the resilience pipeline's signal, so a timeout **cancels the socket** and surfaces a typed `TimeoutError` (never a leaked promise).
  - Runs the fetch inside the optional structural `resilience` pipeline; transport failures are mapped to `RequestError`/`TimeoutError` **at the fetch boundary**, so a policy can retry them.
  - On `!res.ok`, parses an `application/problem+json` body into a typed `ProblemError`, else throws `ResponseError` (when `throwOnError`, default `true`); otherwise decodes the body.
- **Codec seam** — `jsonCodec` is the default; BYO wire format via a small `Codec` (`contentType` + `encode`/`decode`). Raw `BodyInit` values pass through untouched; empty/`204` bodies decode to `undefined`.
- **RFC 7807 Problem Details** (`forge/http/problem`) — `ProblemDetails`, `ProblemError` (carries the document, `toResponse()` renders `application/problem+json`), and `problem.*` constructors for the common statuses (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests`, `internal`). Extension members are preserved.
- **Error taxonomy** (`forge/http/errors`) — `HttpError` base + `RequestError`, `ResponseError`, `TimeoutError`, `ProblemError`, and the forward-declared server-side `RouteConflictError`, `ValidationError`, `OpenApiError`. One `instanceof HttpError` catches the family.
- **Opt-in observability** — inject `telemetry.tracer` to compose `tracedFetch` (client span + outbound `traceparent`); inject `telemetry.meter` to record `http.client.request.duration` (seconds) tagged with `http.request.method`, `http.response.status_code`, `server.address`. Nothing is emitted when no handle is passed.
- **`forge/http/testing`** — `createMockServer()` (programmable fake downstream: canned responses, RFC 7807 errors, latency that respects aborts, transport failures, recorded `requests`), `createTestHttp()` (mock + recording telemetry + a pre-wired client factory), and `STANDARD_HTTP_SCENARIOS` + `assertConformance()` (framework-agnostic client invariants).

### Server

```ts
import { createRouter, serve } from "forge/http/server";
import {
  requestId,
  accessLog,
  problemDetails,
  cors,
  bodyLimit,
  telemetryMiddleware,
} from "forge/http/middleware";

const router = createRouter()
  .use(requestId())
  .use(telemetryMiddleware({ telemetry })) // server span + http.server.* metrics
  .use(problemDetails({ logger })) // every error below → RFC 7807
  .use(cors({ origin: "*" }))
  .use(bodyLimit({ maxBytes: 1_000_000 }))
  .get("/orders/:id", (req) => Response.json({ id: req.params.id }))
  .post("/orders", async (req) =>
    Response.json(await req.json(), { status: 201 }),
  );

const server = serve(router, { port: 3000 });
// … later, drain in-flight requests:
await server.stop();
```

- **`createRouter(options)`** — a **segment-trie** router with path params, exported from `forge/http` and `forge/http/server`. Matching prefers a static segment over a `:param` over a trailing `*` wildcard (with backtracking). Duplicate `method`+`pattern` registrations and conflicting param names at the same position throw a **`RouteConflictError` at registration** (fail-fast at boot). Unmatched paths get `404`; a path that matches another method gets `405` + `Allow`. `use()` adds router-wide middleware, `mount(prefix, sub)` nests a sub-router (its own `use` middleware preserved), verb methods accept route-scoped middleware before the handler.
- **`serve(router, options)`** — a thin adapter over `Bun.serve()`. Each native `Request` becomes an ergonomic `HttpRequest` (`params`/`query`/`json()`/`text()`/`locals`/`signal`, native `raw` always reachable). `stop(closeActiveConnections?)` drains in-flight requests by default and is idempotent.
- **`compose(middleware, handler)`** — the **outermost-first** fold the whole stack is written against: the first middleware sees the request first and the response last, exactly like a `forge/resilience` pipeline. `Middleware = (next: Handler) => Handler`.
- **Built-in middleware** (`forge/http/middleware`) — every export is a factory; none is auto-installed:
  - **`requestId()`** — propagate/mint `x-request-id`, expose on `locals.requestId`, echo on the response.
  - **`accessLog({ logger })`** — one structured line per request (method, path, status, duration).
  - **`problemDetails({ logger })`** — the error boundary: renders `application/problem+json` and **maps Forge errors structurally** (`ProblemError`→its status, `ValidationError`→`422`, `RateLimitError`/`RateLimitedError`→`429`+`Retry-After`, `CircuitOpenError`→`503`, everything else→a **leak-free `500`** logged but never serialized).
  - **`cors(options)`** — standards-compliant preflight (`204`) + response headers.
  - **`bodyLimit({ maxBytes })`** — reject oversized `Content-Length` with a `413` problem.
  - **`telemetryMiddleware({ telemetry })`** — the server mirror of `tracedFetch`: **extract** an inbound `traceparent` and start a `server` span as a remote child, plus `http.server.request.duration` / `http.server.active_requests`. Emits nothing unless a handle is injected.
  - **`rateLimit({ limiter })`** and **`auth({ verifier })`** — thin **structural seams** for `forge/resilience` / `forge/security` (a rejection maps cleanly through `problemDetails`). `rateLimit()` is an admission/back-pressure seam; when a full resilience pipeline is used as the limiter, its execution context is not threaded into `req.signal` for cooperative handler cancellation.
- **`testClient(router)`** (`forge/http/testing`) — an in-process driver (no socket): build a `Request`, get a `Response`, with `get`/`post`/… JSON helpers. Plus `STANDARD_SERVER_SCENARIOS` + `assertServerConformance()` for the framework-agnostic server invariants (compose order + short-circuit, RFC 7807 mapping, inbound-trace continuation, fail-fast conflicts).

### Typed Routes And OpenAPI

```ts
import { createRouter, serve } from "forge/http/server";
import { problemDetails } from "forge/http/middleware";
import { buildOpenApi, serveOpenApi, problemSchema } from "forge/http/openapi";

// `schema` is any structural validator: `parse(input) => T` (+ optional
// `toJsonSchema()`). Zod's `ZodType`, a Valibot wrapper, etc. all satisfy it.
const router = createRouter()
  .use(problemDetails())
  .route({
    method: "POST",
    path: "/orders",
    summary: "Create an order",
    request: { body: CreateOrder }, // validated → typed `locals.body`
    responses: { 201: { body: Order }, 422: problemSchema() },
    handler: (req) => Response.json(create(req.locals.body), { status: 201 }),
  });

// One walk of the router → an OpenAPI 3.1 document; serve it as JSON.
const doc = buildOpenApi(router, {
  info: { title: "Orders", version: "1.0.0" },
});
router.use(serveOpenApi({ doc })); // GET /openapi.json

const server = serve(router, { port: 3000 });
```

- **`router.route(def)`** — a schema-described route: `{ method, path, summary?, description?, tags?, operationId?, request?, responses?, middleware?, handler }`. When `request` is present a `validate()` is **prepended automatically**, and the handler's `locals` are **typed** (`locals.body`/`query`/`params` inferred from the schemas). The `request.body` schema is the single source of truth — the same object validates inbound requests and is emitted as the OpenAPI `requestBody` schema, so the two cannot drift.
- **`validate({ body?, query?, params? })`** (`forge/http/middleware`) — validates each part against a structural **`Schema<T>`** (`parse(input): T`, optional `toJsonSchema()`), storing the typed result on `locals`. A failed `parse()` is wrapped in a **`ValidationError`** carrying the validator's per-field issues (`.issues`/`.errors`), which `problemDetails()` renders as `422` with an `errors` extension. The request body is memoized so `validate()` and the handler can both read it.
- **`buildOpenApi(router, { info, servers?, openapi? })`** (`forge/http/openapi`) — walks every `route()` (mounted routes re-homed under their prefix) and returns a plain **OpenAPI 3.1** object: `:param` → `{param}` templating, path params + query params (expanded from the query schema's object properties), `requestBody`, and `responses`. Invalid metadata (missing `info.title`/`version`, a duplicate operation) throws an **`OpenApiError`** synchronously — fail-fast at build, not on first request.
- **`serveOpenApi({ doc, path? })`** — middleware that serves the document as JSON at `path` (default `/openapi.json`) for `GET`/`HEAD`, delegating everything else.
- **`problemSchema(description?)`** — the RFC 7807 schema as a ready-to-use response entry (`application/problem+json`), so error contracts are documented as first-class citizens rather than implied.
- **Lifecycle integration** — an `HttpServer` from `serve()` already satisfies lifecycle's structural `HttpServerLike`, so `httpServerComponent("http", server)` (`forge/lifecycle/adapters`) drives its graceful `stop()` during ordered shutdown with zero `forge/http` changes.

---

## Design Notes

- **Outermost-first composition.** The client layers timeout → resilience → tracedFetch → fetch, the same wrapping discipline used across Forge modules.
- **Structural dependencies.** `PipelineLike`, `MeterLike`, `TracerLike`, and `Logger` are local shapes; a real `combine(retry, timeout)` or a `forge/telemetry` `Meter`/`Tracer` satisfies them directly.
- **Fail-fast at construction.** Configuration mistakes (e.g. a malformed `baseUrl`) throw synchronously, not on the first request.

# `forge/http`

The request/response **edge** of a Forge application. One module, two faces over the same primitives: a resilient, traced **client** for calling other services, and (in later PRs) a thin typed **server** over `Bun.serve()`. Errors speak one machine-readable dialect — RFC 7807 *Problem Details* — in both directions.

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

## Shipped in PR A — the client face

1. **`createHttpClient(options)`** (`forge/http` · `forge/http/client`) — a resilient, traced `fetch` wrapper. `request()` drives every verb (`get`/`post`/`put`/`patch`/`delete`); `extend()` returns a child with merged config. It:
   - resolves relative paths against `baseUrl` (malformed `baseUrl` **throws at construction**), merges `defaultHeaders` (per-call headers win), applies `query`, and encodes the body via the {@link Codec};
   - arms a per-request `AbortSignal` from `timeoutMs`, combined with the caller's `signal` **and** the resilience pipeline's signal, so a timeout **cancels the socket** and surfaces a typed `TimeoutError` (never a leaked promise);
   - runs the fetch inside the optional structural `resilience` pipeline; transport failures are mapped to `RequestError`/`TimeoutError` **at the fetch boundary**, so a policy can retry them;
   - on `!res.ok`, parses an `application/problem+json` body into a typed `ProblemError`, else throws `ResponseError` (when `throwOnError`, default `true`); otherwise decodes the body.
2. **Codec seam** (`jsonCodec` default) — BYO wire format via a small `Codec` (`contentType` + `encode`/`decode`). Raw `BodyInit` values pass through untouched; empty/`204` bodies decode to `undefined`.
3. **RFC 7807 Problem Details** (`forge/http/problem`) — `ProblemDetails`, `ProblemError` (carries the document, `toResponse()` renders `application/problem+json`), and `problem.*` constructors for the common statuses (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests`, `internal`). Extension members are preserved.
4. **Error taxonomy** (`forge/http/errors`) — `HttpError` base + `RequestError`, `ResponseError`, `TimeoutError`, `ProblemError`, and the forward-declared server-side `RouteConflictError`, `ValidationError`, `OpenApiError`. One `instanceof HttpError` catches the family.
5. **Opt-in observability** — inject `telemetry.tracer` to compose `tracedFetch` (client span + outbound `traceparent`); inject `telemetry.meter` to record `http.client.request.duration` (seconds) tagged with `http.request.method`, `http.response.status_code`, `server.address`. Nothing is emitted when no handle is passed.
6. **`forge/http/testing`** — `createMockServer()` (programmable fake downstream: canned responses, RFC 7807 errors, latency that respects aborts, transport failures, recorded `requests`), `createTestHttp()` (mock + recording telemetry + a pre-wired client factory), and `STANDARD_HTTP_SCENARIOS` + `assertConformance()` (framework-agnostic client invariants).

---

## Coming next

- **PR B — the server face**: a thin typed router/handler/middleware layer over `Bun.serve()`, `problemDetails()` error middleware, the in-process `testClient(router)`, and `httpServerComponent` for `forge/lifecycle`.
- **PR C — typed routes & OpenAPI**: schema-validated routes (`ValidationError`) and OpenAPI generation (`OpenApiError`).

---

## Design notes

- **Outermost-first composition.** The client layers timeout → resilience → tracedFetch → fetch, the same wrapping discipline used across Forge modules.
- **Structural dependencies.** `PipelineLike`, `MeterLike`, `TracerLike`, and `Logger` are local shapes; a real `combine(retry, timeout)` or a `forge/telemetry` `Meter`/`Tracer` satisfies them directly.
- **Fail-fast at construction.** Configuration mistakes (e.g. a malformed `baseUrl`) throw synchronously, not on the first request.

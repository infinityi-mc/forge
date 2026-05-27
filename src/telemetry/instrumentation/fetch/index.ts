/**
 * `tracedFetch` — opt-in client-side HTTP tracing for `fetch`.
 *
 * Wraps a `fetch`-shaped function so every call:
 *
 * - Starts a `client` span named `HTTP <METHOD>` (override with
 *   `spanName`).
 * - Injects W3C `traceparent` / `tracestate` / `baggage` headers from
 *   the active {@link TelemetryContext} so the receiving service can
 *   continue the trace.
 * - Records OpenTelemetry-style HTTP attributes (`http.request.method`,
 *   `http.response.status_code`, `url.full`, `server.address`,
 *   `server.port`, `error.type`).
 * - Sets the span status to `error` on network failure or 5xx response
 *   (4xx is recorded but not marked `error` — that matches the OTel
 *   semantic conventions for HTTP clients).
 *
 * No monkey-patching: consumers explicitly opt in by importing this
 * module and replacing their `fetch` reference with `tracedFetch({ … })`.
 *
 * @example
 * ```ts
 * import { tracedFetch } from "forge/telemetry/instrumentation/fetch";
 *
 * const fetch = tracedFetch({ tracer });
 * const res = await fetch("https://api.example.com/users");
 * ```
 *
 * @module
 */

import type { TelemetryContext } from "../../context/types";
import { currentContext } from "../../context/storage";
import { formatBaggage, formatTraceparent } from "../../context/propagation";
import type { SpanAttributes, Tracer } from "../../trace/types";

/**
 * Minimal fetch-shape we wrap. We use a stripped-down signature
 * (instead of `typeof fetch`) so users can inject any compatible
 * implementation — including the plain `(input, init) => Response`
 * shape — without colliding with Bun's `preconnect` static method.
 */
export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export interface TracedFetchOptions {
  /** Tracer used to start each per-request span. */
  tracer: Tracer;
  /**
   * Underlying fetch. Defaults to the global `fetch`. Provide a custom
   * fetch when you want to compose `tracedFetch` with retry/timeout
   * wrappers, or when injecting a stub in tests.
   */
  fetch?: FetchLike;
  /**
   * Override the span name. Defaults to `HTTP <METHOD>` (e.g. `HTTP GET`).
   */
  spanName?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => string;
  /**
   * Extra attributes added to the span before the request is sent.
   * Merged after the built-in `http.*` attributes so callers can
   * override them.
   */
  attributes?: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => SpanAttributes;
  /**
   * Skip context propagation. Useful for cross-origin calls to vendors
   * that reject unknown headers. Defaults to `false`.
   */
  disablePropagation?: boolean;
}

/**
 * Create a wrapped fetch that produces a client span per request.
 *
 * The returned function has the same call signature as `fetch`. It
 * never throws synchronously; any failures from the underlying fetch
 * are recorded on the span and re-thrown via the returned promise.
 */
export function tracedFetch(options: TracedFetchOptions): FetchLike {
  const tracer = options.tracer;
  const inner: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const buildName =
    options.spanName ?? ((input, init) => `HTTP ${requestMethod(input, init)}`);
  const buildExtra = options.attributes;
  const propagate = options.disablePropagation !== true;

  return (input, init) => {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    const attrs: SpanAttributes = {
      "http.request.method": method,
    };
    if (url) {
      attrs["url.full"] = url;
      const parsed = safeUrl(url);
      if (parsed) {
        attrs["server.address"] = parsed.hostname;
        if (parsed.port) attrs["server.port"] = Number(parsed.port);
        attrs["url.scheme"] = parsed.protocol.replace(/:$/, "");
      }
    }
    const extra = buildExtra ? buildExtra(input, init as RequestInit | undefined) : undefined;
    if (extra) {
      for (const k of Object.keys(extra)) attrs[k] = extra[k];
    }

    // Use `withSpan` so the new span becomes the *active* context for
    // the duration of the request. This is what makes the injected
    // `traceparent` header carry the new client span's id (so the
    // downstream service's spans become children of the client span,
    // not siblings of the caller's span).
    return tracer.withSpan(
      buildName(input, init as RequestInit | undefined),
      async (span): Promise<Response> => {
        span.setAttributes(attrs);
        const nextInit = propagate
          ? injectHeaders(input, init, currentContext())
          : (init as Parameters<typeof fetch>[1]);
        try {
          const res = await inner(input, nextInit);
          span.setAttribute("http.response.status_code", res.status);
          if (res.status >= 500) {
            span.setStatus({
              code: "error",
              message: `HTTP ${res.status}`,
            });
          } else {
            span.setStatus({ code: "ok" });
          }
          return res;
        } catch (err) {
          // Record `error.type` before `withSpan`'s outer catch
          // observes the throw — `withSpan` will then set
          // `status=error` with the thrown message and call `end()`.
          const errorType =
            err instanceof Error && err.name ? err.name : "fetch_error";
          span.setAttribute("error.type", errorType);
          throw err;
        }
      },
      { kind: "client" },
    );
  };
}

function requestMethod(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): string {
  if (init && typeof init.method === "string") return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    const m = (input as { method?: string }).method;
    if (typeof m === "string") return m.toUpperCase();
  }
  return "GET";
}

function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    const u = (input as { url?: string }).url;
    if (typeof u === "string") return u;
  }
  return undefined;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function injectHeaders(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  ctx: TelemetryContext | undefined,
): Parameters<typeof fetch>[1] {
  if (!ctx) return init;
  // Per the Fetch spec, when `fetch(request, init)` is called with
  // `init.headers` present, those headers completely replace the
  // request's own. So we must seed `headers` with the right base:
  //   - explicit init.headers when caller provided them
  //   - otherwise the Request's own headers (so Authorization,
  //     Content-Type, etc. survive when caller passes a Request and
  //     no init)
  //   - otherwise empty
  let base: HeadersInit | undefined;
  if (init?.headers !== undefined) {
    base = init.headers;
  } else if (isRequest(input)) {
    base = input.headers;
  }
  const headers = new Headers(base ?? undefined);
  headers.set("traceparent", formatTraceparent(ctx));
  if (ctx.traceState && ctx.traceState.length > 0) {
    headers.set("tracestate", ctx.traceState);
  }
  if (Object.keys(ctx.baggage).length > 0) {
    headers.set("baggage", formatBaggage(ctx.baggage));
  }
  return { ...(init ?? {}), headers };
}

function isRequest(input: Parameters<typeof fetch>[0]): input is Request {
  return (
    typeof Request !== "undefined" &&
    typeof input === "object" &&
    input !== null &&
    input instanceof Request
  );
}

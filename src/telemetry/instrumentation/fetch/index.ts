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
import type { Span, SpanAttributes, Tracer } from "../../trace/types";

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

  return async (input, init) => {
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

    const span = tracer.startSpan(buildName(input, init as RequestInit | undefined), {
      kind: "client",
      attributes: attrs,
    });

    const nextInit = propagate
      ? injectHeaders(init, currentContext())
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
      span.end();
      return res;
    } catch (err) {
      recordError(span, err);
      span.end();
      throw err;
    }
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
  init: Parameters<typeof fetch>[1],
  ctx: TelemetryContext | undefined,
): Parameters<typeof fetch>[1] {
  if (!ctx) return init;
  const headers = new Headers(init?.headers ?? undefined);
  headers.set("traceparent", formatTraceparent(ctx));
  if (ctx.traceState && ctx.traceState.length > 0) {
    headers.set("tracestate", ctx.traceState);
  }
  if (Object.keys(ctx.baggage).length > 0) {
    headers.set("baggage", formatBaggage(ctx.baggage));
  }
  return { ...(init ?? {}), headers };
}

function recordError(span: Span, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const errorType =
    err instanceof Error && err.name ? err.name : "fetch_error";
  span.setAttribute("error.type", errorType);
  span.setStatus({ code: "error", message });
}

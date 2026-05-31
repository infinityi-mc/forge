/**
 * `telemetryMiddleware()` — the server-side mirror of the client's
 * `tracedFetch`: **extract** an inbound W3C `traceparent` (instead of
 * injecting one), start a `server` span as a remote child, and emit the
 * OTel-aligned `http.server.*` instruments. Reuses `forge/telemetry/context`
 * for the W3C parsing — no new propagation code, no hard telemetry import
 * (the handle is the structural {@link HttpTelemetry}).
 *
 * Emits nothing unless a `meter`/`tracer` is supplied. `5xx` marks the span
 * `error`; `4xx` is recorded but not `error` (matching the client convention).
 * `http.route` is read from `locals.route` after `next` resolves, so the
 * label is the matched pattern (`/users/:id`), not the concrete path.
 *
 * @module
 */

import { extract, objectCarrier, withContext } from "../../telemetry/context";
import type { HttpTelemetry, SpanLike } from "../observability";
import type { Handler, HttpRequest, Middleware } from "../types";

/** Options for {@link telemetryMiddleware}. */
export interface TelemetryMiddlewareOptions {
  readonly telemetry?: HttpTelemetry;
}

const DURATION = "http.server.request.duration";
const ACTIVE = "http.server.active_requests";

/** Server spans + `http.server.*` metrics, opt-in by injection. */
export function telemetryMiddleware(
  options: TelemetryMiddlewareOptions = {},
): Middleware {
  const telemetry = options.telemetry;
  const meter = telemetry?.meter;
  const tracer = telemetry?.tracer;

  const duration = meter?.createHistogram(DURATION, {
    description: "Duration of inbound HTTP server requests.",
    unit: "s",
  });
  // UpDownCounter (not Counter): in-flight count must decrement on completion;
  // a monotonic Counter silently drops the `add(-1)` below.
  const active = meter?.createUpDownCounter(ACTIVE, {
    description: "In-flight inbound HTTP server requests.",
  });

  return (next: Handler): Handler =>
    async (req) => {
      if (!duration && !active && !tracer) return next(req);

      const method = req.method;
      const start = performance.now();
      active?.add(1, { "http.request.method": method });

      const run = async (span?: SpanLike): Promise<Response> => {
        try {
          const res = await next(req);
          const route = routeOf(req);
          const attrs = {
            "http.request.method": method,
            "http.route": route,
            "http.response.status_code": res.status,
          };
          duration?.record((performance.now() - start) / 1000, attrs);
          if (span) {
            span.setAttribute("http.response.status_code", res.status);
            span.setAttribute("http.route", route);
            if (res.status >= 500) {
              span.setStatus({ code: "error", message: `HTTP ${res.status}` });
            }
          }
          return res;
        } catch (error) {
          // The error propagates to problemDetails(); still record duration as
          // a 500 and mark the span so failures aren't invisible.
          const route = routeOf(req);
          duration?.record((performance.now() - start) / 1000, {
            "http.request.method": method,
            "http.route": route,
            "http.response.status_code": 500,
          });
          span?.setStatus({
            code: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          active?.add(-1, { "http.request.method": method });
        }
      };

      if (!tracer) return run();

      const remote = extract(objectCarrier(headerRecord(req.headers)));
      const spanFn = (span: SpanLike): Promise<Response> => {
        span.setAttribute("http.request.method", method);
        span.setAttribute("url.path", req.url.pathname);
        return run(span);
      };
      // Adopt the remote trace context (if any) so the server span continues
      // the caller's trace rather than starting a disconnected one.
      return remote
        ? withContext(remote, () => tracer.withSpan(`HTTP ${method}`, spanFn, { kind: "server" }))
        : tracer.withSpan(`HTTP ${method}`, spanFn, { kind: "server" });
    };
}

function routeOf(req: HttpRequest): string {
  const route = req.locals.route;
  return typeof route === "string" ? route : req.url.pathname;
}

function headerRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

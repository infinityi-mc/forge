/**
 * `forge/http/middleware` — the built-in middleware stack.
 *
 * Each export is a **factory** returning a {@link Middleware}; none is
 * auto-installed (Principle 6: explicit wiring only). They compose
 * outermost-first via `forge/http/server`'s `compose`, exactly like a
 * `forge/resilience` pipeline. `validate()` (PR C) drives schema-checked
 * typed routes and feeds the same schemas to OpenAPI generation.
 *
 * @example
 * ```ts
 * createRouter()
 *   .use(requestId())
 *   .use(telemetryMiddleware({ telemetry }))
 *   .use(problemDetails())          // renders RFC 7807 for everything below
 *   .use(cors({ origin: "*" }))
 *   .get("/orders/:id", handler);
 * ```
 *
 * @module
 */

import { ProblemError, ValidationError } from "../errors";
import { renderProblem } from "../problem/render";
import type { Logger } from "../observability";
import type { Handler, HttpRequest, Middleware } from "../types";
import type { Schema } from "../server/types";

export { problemDetails } from "./problem";
export type { ProblemDetailsOptions } from "./problem";
export { telemetryMiddleware } from "./telemetry";
export type { TelemetryMiddlewareOptions } from "./telemetry";

const REQUEST_ID_HEADER = "x-request-id";

/** Options for {@link requestId}. */
export interface RequestIdOptions {
  /** Header carrying the id. Default `x-request-id`. */
  readonly header?: string;
  /** Id generator when the inbound request has none. Default `crypto.randomUUID`. */
  readonly generate?: () => string;
}

/**
 * Propagate an inbound request id or mint one, expose it on
 * `locals.requestId`, and echo it on the response.
 */
export function requestId(options: RequestIdOptions = {}): Middleware {
  const header = options.header ?? REQUEST_ID_HEADER;
  const generate = options.generate ?? (() => crypto.randomUUID());
  return (next: Handler): Handler =>
    async (req) => {
      const id = req.headers.get(header) ?? generate();
      req.locals.requestId = id;
      const res = await next(req);
      if (!res.headers.has(header)) res.headers.set(header, id);
      return res;
    };
}

/** Options for {@link accessLog}. */
export interface AccessLogOptions {
  /** Structural logger; nothing is logged when absent. */
  readonly logger?: Logger;
  /** Log message. Default `http_request`. */
  readonly message?: string;
}

/** One structured log line per request (method, path, status, duration). */
export function accessLog(options: AccessLogOptions = {}): Middleware {
  const logger = options.logger;
  const message = options.message ?? "http_request";
  return (next: Handler): Handler =>
    async (req) => {
      if (!logger) return next(req);
      const start = performance.now();
      const base = { method: req.method, path: req.url.pathname };
      try {
        const res = await next(req);
        logger.info(message, {
          ...base,
          status: res.status,
          durationMs: round(performance.now() - start),
        });
        return res;
      } catch (error) {
        logger.error(message, {
          ...base,
          status: 500,
          durationMs: round(performance.now() - start),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
}

/** Options for {@link cors}. */
export interface CorsOptions {
  /** Allowed origin(s): `"*"`, an exact origin, a list, or a predicate. */
  readonly origin?: "*" | string | readonly string[] | ((origin: string) => boolean);
  /** Allowed methods. Default `GET,HEAD,PUT,PATCH,POST,DELETE`. */
  readonly methods?: readonly string[];
  /** Allowed request headers (preflight `Access-Control-Allow-Headers`). */
  readonly allowedHeaders?: readonly string[];
  /** Headers exposed to the browser (`Access-Control-Expose-Headers`). */
  readonly exposedHeaders?: readonly string[];
  /** Send `Access-Control-Allow-Credentials: true`. */
  readonly credentials?: boolean;
  /** Preflight cache lifetime in seconds (`Access-Control-Max-Age`). */
  readonly maxAge?: number;
}

const DEFAULT_CORS_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

/** Standards-compliant CORS preflight + response headers. */
export function cors(options: CorsOptions = {}): Middleware {
  const allowOrigin = originResolver(options.origin ?? "*");
  const methods = (options.methods ?? DEFAULT_CORS_METHODS).join(", ");
  return (next: Handler): Handler =>
    async (req) => {
      const requestOrigin = req.headers.get("origin");
      const allowed = requestOrigin !== null ? allowOrigin(requestOrigin) : undefined;

      // Preflight: an OPTIONS carrying Access-Control-Request-Method.
      if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
        const headers = new Headers({ "access-control-allow-methods": methods });
        applyOrigin(headers, allowed, requestOrigin, options.credentials);
        const reqHeaders =
          options.allowedHeaders?.join(", ") ??
          req.headers.get("access-control-request-headers") ??
          undefined;
        if (reqHeaders) headers.set("access-control-allow-headers", reqHeaders);
        if (options.maxAge !== undefined) {
          headers.set("access-control-max-age", String(options.maxAge));
        }
        headers.append("vary", "Origin");
        return new Response(null, { status: 204, headers });
      }

      const res = await next(req);
      applyOrigin(res.headers, allowed, requestOrigin, options.credentials);
      if (options.exposedHeaders?.length) {
        res.headers.set("access-control-expose-headers", options.exposedHeaders.join(", "));
      }
      res.headers.append("vary", "Origin");
      return res;
    };
}

function originResolver(
  origin: "*" | string | readonly string[] | ((origin: string) => boolean),
): (requestOrigin: string) => string | undefined {
  if (origin === "*") return () => "*";
  if (typeof origin === "function") return (o) => (origin(o) ? o : undefined);
  if (Array.isArray(origin)) {
    const set = new Set(origin);
    return (o) => (set.has(o) ? o : undefined);
  }
  const only = origin as string;
  return (o) => (o === only ? o : undefined);
}

function applyOrigin(
  headers: Headers,
  allowed: string | undefined,
  requestOrigin: string | null,
  credentials?: boolean,
): void {
  if (allowed === undefined) return;
  // Per the Fetch Standard §3.2.5, `Access-Control-Allow-Origin` must not be
  // `*` when credentials are allowed — browsers reject the response. Echo the
  // concrete request Origin instead (kept cacheable as `*` otherwise).
  const value = credentials && allowed === "*" && requestOrigin ? requestOrigin : allowed;
  headers.set("access-control-allow-origin", value);
  if (credentials) headers.set("access-control-allow-credentials", "true");
}

/** Options for {@link bodyLimit}. */
export interface BodyLimitOptions {
  /** Maximum allowed request body size in bytes. */
  readonly maxBytes: number;
}

/**
 * Reject requests whose declared `Content-Length` exceeds `maxBytes` with a
 * `413` RFC 7807 problem. (Streaming bodies without a length are passed
 * through — enforce those at read time.)
 */
export function bodyLimit(options: BodyLimitOptions): Middleware {
  const max = options.maxBytes;
  return (next: Handler): Handler =>
    (req) => {
      const length = req.headers.get("content-length");
      if (length !== null && Number(length) > max) {
        return renderProblem({
          status: 413,
          detail: `Request body exceeds the ${max}-byte limit`,
        });
      }
      return next(req);
    };
}

/** A structural rate limiter (a `forge/resilience` pipeline satisfies this). */
export interface Limiter {
  execute<T>(op: () => Promise<T> | T): Promise<T>;
}

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  /** The limiter to run each request through. */
  readonly limiter: Limiter;
}

/**
 * Back-pressure via a structural `forge/resilience` rate limiter. A
 * `RateLimitError` thrown by the limiter propagates to `problemDetails()`,
 * which renders `429` with `Retry-After`.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const limiter = options.limiter;
  return (next: Handler): Handler =>
    (req) => limiter.execute(() => next(req));
}

/** Options for {@link auth}. */
export interface AuthOptions<P = unknown> {
  /**
   * Verify the request and return a principal. Throw (e.g. a
   * `problem.unauthorized()`) to reject. The mount point for
   * `forge/security` JWT/JWKS + AuthZ.
   */
  readonly verifier: (req: HttpRequest) => Promise<P> | P;
  /** `locals` key the principal is stored under. Default `principal`. */
  readonly into?: string;
}

/** Structural mount point for authentication; populates `locals[into]`. */
export function auth<P = unknown>(options: AuthOptions<P>): Middleware {
  const into = options.into ?? "principal";
  return (next: Handler): Handler =>
    async (req) => {
      const principal = await options.verifier(req);
      req.locals[into] = principal;
      return next(req);
    };
}

/** Options for {@link validate}: a {@link Schema} per request part. */
export interface ValidateOptions {
  /** Validates the JSON body; the result is stored on `locals.body`. */
  readonly body?: Schema;
  /** Validates the query (parsed to a plain object); stored on `locals.query`. */
  readonly query?: Schema;
  /** Validates the path params; stored on `locals.params`. */
  readonly params?: Schema;
}

/**
 * Validate request parts against structural {@link Schema}s, populating typed
 * `locals` (`body`/`query`/`params`). A failed `parse()` is wrapped in a
 * {@link ValidationError} (→ `422` via `problemDetails`), surfacing the
 * validator's per-field issues as the RFC 7807 `errors` extension. `route()`
 * prepends this automatically when a `request` schema set is given.
 */
export function validate(options: ValidateOptions): Middleware {
  return (next: Handler): Handler =>
    async (req) => {
      if (options.params) {
        req.locals.params = run("params", options.params, { ...req.params });
      }
      if (options.query) {
        req.locals.query = run("query", options.query, queryToObject(req.query));
      }
      if (options.body) {
        const raw = await req.json().catch((cause: unknown) => {
          throw new ValidationError("invalid body: malformed JSON", { cause });
        });
        req.locals.body = run("body", options.body, raw);
      }
      return next(req);
    };
}

/** Run one schema, normalizing any thrown error into a {@link ValidationError}. */
function run(where: string, schema: Schema, input: unknown): unknown {
  try {
    return schema.parse(input);
  } catch (cause) {
    throw new ValidationError(`invalid ${where}`, {
      cause,
      errors: extractIssues(cause),
    });
  }
}

/** Pull a validator's structured issues (Zod `.issues`, others `.errors`). */
function extractIssues(cause: unknown): unknown {
  if (cause !== null && typeof cause === "object") {
    const obj = cause as { issues?: unknown; errors?: unknown };
    if (Array.isArray(obj.issues)) return obj.issues;
    if (Array.isArray(obj.errors)) return obj.errors;
  }
  return undefined;
}

/** Flatten a query string to a plain object (last value wins on repeats). */
function queryToObject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query) out[key] = value;
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

// Re-exported for convenience so handlers can throw a typed 401/403 etc.
export { ProblemError };

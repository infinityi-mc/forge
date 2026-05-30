/**
 * Server-side contracts for `forge/http` — the {@link Router}, the
 * {@link HttpServer} handle, and their option bags.
 *
 * @module
 */

import type { Handler, HttpRequest, Middleware, RouteHandlers } from "../types";

/**
 * A structural validator — anything with a throwing `parse(input): T`.
 * Zod's `ZodType`, a Valibot wrapper, or a hand-rolled checker all satisfy
 * it; `forge/http` never hard-imports a validation library (mirrors how
 * `MeterLike`/`PipelineLike` keep telemetry/resilience structural).
 *
 * `toJsonSchema()` is optional: when present, {@link buildOpenApi} emits the
 * returned fragment; when absent it falls back to a permissive `{}`.
 */
export interface Schema<T = unknown> {
  /** Validate `input`, returning the typed value or throwing on failure. */
  parse(input: unknown): T;
  /** Optional OpenAPI 3.1 / JSON-Schema fragment describing the value. */
  toJsonSchema?(): JsonSchema;
}

/** A JSON-Schema / OpenAPI 3.1 schema object (intentionally open-ended). */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The value a {@link Schema} yields, or `undefined` when no schema is set. */
export type Infer<S> = S extends Schema<infer T> ? T : undefined;

/** Per-route request schemas consumed by `validate()` + OpenAPI generation. */
export interface RouteRequest {
  /** Validates (and types) the JSON body. */
  readonly body?: Schema;
  /** Validates the query string (parsed to a plain object first). */
  readonly query?: Schema;
  /** Validates the matched path params. */
  readonly params?: Schema;
}

/** A documented response entry for a status code. */
export interface ResponseObject {
  /** Human-readable description (OpenAPI requires one; a default is supplied). */
  readonly description?: string;
  /** Body schema for this response. */
  readonly body?: Schema;
  /** Content type. Default `application/json`; `problemSchema()` sets `application/problem+json`. */
  readonly contentType?: string;
}

/** The validated values `validate()` writes onto `locals` for a {@link RouteDef}. */
export interface ValidatedLocals<Req extends RouteRequest> {
  readonly body: Infer<Req["body"]>;
  readonly query: Infer<Req["query"]>;
  readonly params: Infer<Req["params"]>;
}

/**
 * The request a typed {@link RouteDef} handler sees: an {@link HttpRequest}
 * whose `locals` additionally carries the validated `body`/`query`/`params`.
 */
export type TypedRequest<Req extends RouteRequest> = Omit<HttpRequest, "locals"> & {
  readonly locals: Record<string, unknown> & ValidatedLocals<Req>;
};

/** Handler for a {@link RouteDef}, with `locals` typed from the request schemas. */
export type TypedHandler<Req extends RouteRequest> = (
  req: TypedRequest<Req>,
) => Promise<Response> | Response;

/**
 * A schema-described route: the single source of truth that the router
 * **validates** against at runtime and {@link buildOpenApi} **documents**.
 */
export interface RouteDef<Req extends RouteRequest = RouteRequest> {
  /** HTTP method (case-insensitive). */
  readonly method: string;
  /** Path pattern, same grammar as the verb methods (`/orders/:id`). */
  readonly path: string;
  /** OpenAPI `summary`. */
  readonly summary?: string;
  /** OpenAPI `description`. */
  readonly description?: string;
  /** OpenAPI `tags`. */
  readonly tags?: readonly string[];
  /** OpenAPI `operationId`. */
  readonly operationId?: string;
  /** Request schemas; when present, a `validate()` is prepended automatically. */
  readonly request?: Req;
  /** Documented responses keyed by status code. */
  readonly responses?: Readonly<Record<number, ResponseObject>>;
  /** Route-scoped middleware, applied before the handler (after `validate`). */
  readonly middleware?: readonly Middleware[];
  /** The terminal handler, with typed `locals`. */
  readonly handler: TypedHandler<Req>;
}

/**
 * The OpenAPI-relevant metadata recorded for each {@link RouteDef}, read by
 * {@link buildOpenApi}. Paths use the router's `:param` grammar (converted to
 * `{param}` templating during document generation).
 */
export interface RouteMeta {
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly request?: RouteRequest;
  readonly responses?: Readonly<Record<number, ResponseObject>>;
}

/** Options for {@link createRouter}. */
export interface RouterOptions {
  /**
   * Terminal handler when no route matches. Defaults to a bare `404`.
   * (Mount `problemDetails()` to render it as RFC 7807.)
   */
  readonly notFound?: Handler;
}

/**
 * A composable router. Verb methods register a path + handler (optionally
 * preceded by route-scoped middleware); `use` adds router-wide middleware;
 * `mount` nests a sub-router under a prefix; `handler()` folds everything
 * into a single {@link Handler} suitable for `Bun.serve`.
 *
 * Every method returns `this` for chaining.
 */
export interface Router {
  get(path: string, ...handlers: RouteHandlers): Router;
  post(path: string, ...handlers: RouteHandlers): Router;
  put(path: string, ...handlers: RouteHandlers): Router;
  patch(path: string, ...handlers: RouteHandlers): Router;
  delete(path: string, ...handlers: RouteHandlers): Router;
  /** Register a handler for an arbitrary method. */
  on(method: string, path: string, ...handlers: RouteHandlers): Router;
  /**
   * Register a schema-described route: validates `request` schemas into typed
   * `locals` and records OpenAPI metadata for {@link buildOpenApi}. A
   * `validate()` is prepended automatically when `request` is present.
   */
  route<Req extends RouteRequest>(def: RouteDef<Req>): Router;
  /** Add router-wide middleware (applied outermost-first, in call order). */
  use(mw: Middleware): Router;
  /** Mount a sub-router under `prefix`; the parent's `use` middleware wraps it. */
  mount(prefix: string, sub: Router): Router;
  /** Build the folded `fetch` handler for `Bun.serve`. */
  handler(): Handler;
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Port to bind. `0` (default in Bun) picks a free port. */
  readonly port?: number;
  /** Hostname/interface to bind. */
  readonly hostname?: string;
  /** Bind a Unix domain socket instead of a TCP port. */
  readonly unix?: string;
}

/** A running HTTP server handle (mirrors the spec + `forge/lifecycle`). */
export interface HttpServer {
  /** The bound port (`0` for a Unix socket). */
  readonly port: number;
  /** The server's base URL. */
  readonly url: string;
  /**
   * Stop the server. `closeActiveConnections` (default `false`) forcibly
   * closes in-flight requests instead of draining them. Idempotent.
   */
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/**
 * Server-side contracts for `forge/http` — the {@link Router}, the
 * {@link HttpServer} handle, and their option bags.
 *
 * @module
 */

import type { Handler, Middleware, RouteHandlers } from "../types";

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

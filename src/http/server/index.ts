/**
 * `forge/http/server` — the server face of `forge/http`.
 *
 * A thin, typed routing + middleware layer over `Bun.serve()`:
 * {@link createRouter} (segment-trie matching, path params, fail-fast route
 * conflicts), {@link serve} (graceful `stop()`), and {@link compose} (the
 * outermost-first middleware fold the built-ins are written against).
 * Built-in middleware live in `forge/http/middleware`.
 *
 * @module
 */

export { createRouter, routeMetadata } from "./router";
export { serve } from "./serve";
export { compose } from "./compose";
export { createHttpRequest } from "./request";

export type {
  Router,
  RouterOptions,
  ServeOptions,
  HttpServer,
  Schema,
  JsonSchema,
  Infer,
  RouteRequest,
  ResponseObject,
  RouteDef,
  RouteMeta,
  TypedHandler,
  TypedRequest,
  ValidatedLocals,
} from "./types";

export type {
  HttpRequest,
  Handler,
  Middleware,
  RouteHandlers,
} from "../types";

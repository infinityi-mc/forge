/**
 * `forge/http` — the request/response edge of a Forge application.
 *
 * Two faces share one set of primitives: a resilient, traced **client**
 * for calling other services, and a thin typed **server** over
 * `Bun.serve()`. PR A shipped the client, the RFC 7807 *Problem Details*
 * surface, the error taxonomy, and the `forge/http/testing` doubles; PR B
 * added the server router, middleware stack, and server tracing; PR C adds
 * schema-validated typed routes (`route()`/`validate()`) and OpenAPI 3.1
 * generation (`buildOpenApi`/`serveOpenApi`/`problemSchema`).
 *
 * @module
 */

// Client
export { createHttpClient } from "./client";
export type {
  HttpClient,
  HttpClientOptions,
  PipelineLike,
  PipelineContextLike,
} from "./client/types";

// Core types
export type {
  ClientInit,
  ClientRequest,
  HttpResponse,
  FetchLike,
  ProblemDetails,
} from "./types";

// Server
export {
  createRouter,
  serve,
  compose,
  createHttpRequest,
  routeMetadata,
} from "./server";
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
} from "./server/types";
export type {
  HttpRequest,
  Handler,
  Middleware,
  RouteHandlers,
} from "./types";

// Built-in middleware
export {
  requestId,
  accessLog,
  cors,
  bodyLimit,
  rateLimit,
  auth,
  problemDetails,
  telemetryMiddleware,
  validate,
} from "./middleware";
export type {
  RequestIdOptions,
  AccessLogOptions,
  CorsOptions,
  BodyLimitOptions,
  RateLimitOptions,
  Limiter,
  AuthOptions,
  ProblemDetailsOptions,
  TelemetryMiddlewareOptions,
  ValidateOptions,
} from "./middleware";

// OpenAPI 3.1 generation
export { buildOpenApi, serveOpenApi, problemSchema } from "./openapi";
export type {
  OpenApiInfo,
  BuildOpenApiOptions,
  OpenApiDocument,
  ServeOpenApiOptions,
} from "./openapi";

// Codec
export { jsonCodec } from "./codec";
export type { Codec } from "./codec";

// Problem Details (RFC 7807)
export {
  problem,
  ProblemError,
  renderProblem,
  normalizeProblem,
  PROBLEM_CONTENT_TYPE,
  DEFAULT_PROBLEM_TYPE,
} from "./problem";

// Error taxonomy
export {
  HttpError,
  RequestError,
  ResponseError,
  TimeoutError,
  RouteConflictError,
  ValidationError,
  OpenApiError,
} from "./errors";

// Structural observability handles
export type {
  HttpTelemetry,
  MeterLike,
  TracerLike,
  SpanLike,
  CounterLike,
  HistogramLike,
  Logger,
  MetricAttributes,
  SpanAttributes,
  SpanKind,
} from "./observability";

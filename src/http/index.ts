/**
 * `forge/http` — the request/response edge of a Forge application.
 *
 * Two faces share one set of primitives: a resilient, traced **client**
 * for calling other services, and (in later PRs) a thin typed **server**
 * over `Bun.serve()`. PR A ships the client, the RFC 7807 *Problem
 * Details* surface, the error taxonomy, and the `forge/http/testing`
 * doubles.
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

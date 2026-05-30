/**
 * Public client contracts for `forge/http/client`.
 *
 * @module
 */

import type { Codec } from "../codec";
import type { HttpTelemetry, Logger } from "../observability";
import type {
  ClientInit,
  ClientRequest,
  FetchLike,
  HttpResponse,
} from "../types";

/**
 * Execution context handed to an operation by a {@link PipelineLike}.
 * Structurally a subset of `forge/resilience`'s `ExecutionContext` — the
 * only field the client reads is the cancellation `signal`.
 */
export interface PipelineContextLike {
  readonly signal: AbortSignal;
}

/**
 * Structural view of a `forge/resilience` `Pipeline`. A real
 * `combine(retry, timeout, breaker)` is assignable to this, so the client
 * gets resilience by composition with **no hard import**.
 */
export interface PipelineLike {
  execute<T>(op: (ctx: PipelineContextLike) => Promise<T> | T): Promise<T>;
}

/** A resilient, traced `fetch` wrapper for calling other services. */
export interface HttpClient {
  /** Issue a fully-described request. */
  request<T = unknown>(req: ClientRequest): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, init?: ClientInit): Promise<HttpResponse<T>>;
  post<T = unknown>(url: string, body?: unknown, init?: ClientInit): Promise<HttpResponse<T>>;
  put<T = unknown>(url: string, body?: unknown, init?: ClientInit): Promise<HttpResponse<T>>;
  patch<T = unknown>(url: string, body?: unknown, init?: ClientInit): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, init?: ClientInit): Promise<HttpResponse<T>>;
  /** A new client inheriting this one's config, with overrides applied. */
  extend(overrides: Partial<HttpClientOptions>): HttpClient;
}

/** Construction options for {@link createHttpClient}. */
export interface HttpClientOptions {
  /** Base URL relative request paths resolve against. Validated at construction. */
  readonly baseUrl?: string;
  /** Headers merged into every request (per-request headers win). */
  readonly defaultHeaders?: Record<string, string>;
  /** Per-request timeout, backed by an `AbortSignal` that cancels the socket. */
  readonly timeoutMs?: number;
  /** A `forge/resilience` pipeline applied per request (structural). */
  readonly resilience?: PipelineLike;
  /** Parse RFC 7807 error bodies into `ProblemError` on `!res.ok`. Default `true`. */
  readonly parseProblem?: boolean;
  /** Throw on non-2xx (default `true`) or resolve the response (`false`). */
  readonly throwOnError?: boolean;
  /** Body (de)serialization. Default {@link jsonCodec}. */
  readonly codec?: Codec;
  /** Underlying fetch. Inject for tests, `MockServer`, or a pre-wrapped fetch. */
  readonly fetch?: FetchLike;
  /** Opt-in telemetry: composes `tracedFetch` and records `http.client.*`. */
  readonly telemetry?: HttpTelemetry;
  /** Opt-in structural logger. */
  readonly logger?: Logger;
}

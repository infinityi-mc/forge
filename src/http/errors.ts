/**
 * Typed error taxonomy for `forge/http`.
 *
 * Mirrors the per-module base-class pattern (`DataError`, `ConfigError`,
 * `ResilienceError`, `MessagingError`, `LifecycleError`): every error the
 * module throws extends {@link HttpError}, so consumers can branch with a
 * single `instanceof HttpError` or narrow to a specific class.
 *
 * Exported from both `forge/http` and `forge/http/errors`.
 *
 * @module
 */

import type { ProblemDetails } from "./types";
import { renderProblem, normalizeProblem } from "./problem/render";

/**
 * Base class for every error thrown by `forge/http`. Use this when no
 * more specific category fits, or for a family-wide `instanceof` check.
 */
export class HttpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
  }
}

/**
 * Carries an RFC 7807 {@link ProblemDetails}. Thrown by handlers (server)
 * or produced by the client when it parses an `application/problem+json`
 * error body. Renders to a `application/problem+json` {@link Response}.
 */
export class ProblemError extends HttpError {
  readonly problem: ProblemDetails;

  constructor(
    problem: Partial<ProblemDetails> & { status: number },
    options?: ErrorOptions,
  ) {
    const normalized = normalizeProblem(problem);
    super(normalized.detail ?? normalized.title, options);
    this.name = "ProblemError";
    this.problem = normalized;
  }

  /** HTTP status code of the underlying problem. */
  get status(): number {
    return this.problem.status;
  }

  /** Serialize to a `application/problem+json` {@link Response}. */
  toResponse(): Response {
    return renderProblem(this.problem);
  }
}

/** Client-side failure building or transporting a request (e.g. network error). */
export class RequestError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestError";
  }
}

/**
 * Client-side non-2xx response when `throwOnError` is set and the body is
 * not an RFC 7807 problem (those become {@link ProblemError}). Carries the
 * raw {@link Response} for inspection.
 */
export class ResponseError extends HttpError {
  readonly status: number;
  readonly response: Response;

  constructor(response: Response, message?: string, options?: ErrorOptions) {
    super(message ?? `HTTP ${response.status}`, options);
    this.name = "ResponseError";
    this.status = response.status;
    this.response = response;
  }
}

/** A client request exceeded its `timeoutMs`; the underlying fetch was aborted. */
export class TimeoutError extends HttpError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`request timed out after ${timeoutMs}ms`, options);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Server: a duplicate route registered at construction time. Thrown
 * synchronously by the router (PR B) — declared here so the taxonomy is
 * complete and stable across PRs.
 */
export class RouteConflictError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RouteConflictError";
  }
}

/**
 * Server: body/query/params validation failure (PR C). `problemDetails()`
 * renders it as `422`, surfacing {@link errors} as the RFC 7807 `errors`
 * extension when present (e.g. a validator's per-field issues).
 */
export class ValidationError extends HttpError {
  /** Structured per-field issues, surfaced in the `422` problem body. */
  readonly errors?: unknown;

  constructor(message: string, options?: ErrorOptions & { errors?: unknown }) {
    super(message, options);
    this.name = "ValidationError";
    if (options?.errors !== undefined) this.errors = options.errors;
  }
}

/** Server: invalid OpenAPI metadata (PR C). */
export class OpenApiError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenApiError";
  }
}

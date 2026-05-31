/**
 * `problemDetails()` — the error boundary that makes RFC 7807 the *only*
 * way errors leave the server.
 *
 * Mounted near the top of the stack so everything below it is covered: it
 * runs `next`, and on a thrown error renders an `application/problem+json`
 * {@link Response}. Known errors map to sensible statuses **without leaking
 * internals**; anything unmapped becomes a generic `500` whose `detail` is
 * omitted (the full error goes to the injected `logger`/telemetry, never the
 * wire).
 *
 * Forge errors are matched **structurally** (by class where imported, else
 * by `name`/shape) so this stays free of a hard `forge/resilience` import:
 *
 * | Error | Status | Notes |
 * | :-- | :-- | :-- |
 * | `ProblemError` | its own | rendered verbatim (extensions preserved) |
 * | `ValidationError` | `422` | `errors[]` extension when present |
 * | `AuthenticationError` (+ subclasses) | `401` | `forge/security` authn family |
 * | `AuthorizationError` | `403` | `forge/security` policy deny |
 * | `RateLimitError` / `RateLimitedError` | `429` | `Retry-After` from `retryAfterMs` |
 * | `CircuitOpenError` | `503` | dependency unavailable |
 * | _anything else_ | `500` | no `detail`; logged, not leaked |
 *
 * @module
 */

import { ProblemError, ValidationError } from "../errors";
import { renderProblem } from "../problem/render";
import type { Logger } from "../observability";
import type { Handler, Middleware } from "../types";

/**
 * `forge/security` authentication-error class names (the base plus its
 * subclasses). Kept as a literal set so the mapping stays a structural
 * `name` match — no `forge/security` import.
 */
const AUTHENTICATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AuthenticationError",
  "TokenExpiredError",
  "TokenInvalidError",
  "TokenClaimError",
  "AlgorithmNotAllowedError",
]);

/** Options for {@link problemDetails}. */
export interface ProblemDetailsOptions {
  /** Logger for unmapped 5xx errors (full error/stack stays here, off the wire). */
  readonly logger?: Logger;
  /**
   * Escape hatch: map a thrown value to a problem before the built-in
   * mapping runs. Return `undefined` to fall through to the defaults.
   */
  readonly map?: (error: unknown) => Response | undefined;
}

/** Catch thrown errors below this middleware and render RFC 7807. */
export function problemDetails(options: ProblemDetailsOptions = {}): Middleware {
  return (next: Handler): Handler =>
    async (req) => {
      try {
        return await next(req);
      } catch (error) {
        const custom = options.map?.(error);
        if (custom) return custom;
        return renderError(error, options.logger);
      }
    };
}

function renderError(error: unknown, logger?: Logger): Response {
  if (error instanceof ProblemError) {
    return error.toResponse();
  }

  if (error instanceof ValidationError) {
    const errors = (error as { errors?: unknown }).errors;
    return renderProblem({
      status: 422,
      detail: error.message,
      ...(errors !== undefined ? { errors } : {}),
    });
  }

  // Structural mapping for forge/security errors (no hard import): the
  // authentication family → 401, authorization → 403. Matched by `name`
  // (each subclass sets its own) so subclasses map without an instanceof.
  const name = error instanceof Error ? error.name : "";
  if (AUTHENTICATION_ERROR_NAMES.has(name)) {
    return renderProblem({ status: 401, detail: "Authentication required" });
  }
  if (name === "AuthorizationError") {
    return renderProblem({ status: 403, detail: "Access denied" });
  }

  // Structural mapping for forge/resilience errors (no hard import).
  if (name === "RateLimitError" || name === "RateLimitedError") {
    const res = renderProblem({ status: 429, detail: "Rate limit exceeded" });
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
    if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
      res.headers.set("retry-after", String(Math.ceil(retryAfterMs / 1000)));
    }
    return res;
  }
  if (name === "CircuitOpenError") {
    return renderProblem({ status: 503, detail: "Dependency unavailable" });
  }

  // Unmapped: generic 500 with no detail. The real error is logged, never
  // serialized to the client.
  logger?.error("unhandled error in request handler", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return renderProblem({ status: 500 });
}

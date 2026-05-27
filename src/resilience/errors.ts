/**
 * Typed error taxonomy for `forge/resilience`.
 *
 * Every policy throws a subclass of {@link ResilienceError} so
 * consumers can branch with a single `instanceof ResilienceError`
 * check for transport-agnostic recovery, or narrow to a specific
 * policy's error class.
 *
 * Two of these errors — {@link TransientError} and
 * {@link RateLimitError} — are designed to be *thrown by user code*
 * inside an operation so `retry` and friends know what to do. The
 * rest are thrown *by policies* themselves (e.g. `RetryExhaustedError`
 * when retries run out, `TimeoutError` when a deadline elapses).
 *
 * @module
 */

/**
 * Base class for every error thrown by `forge/resilience`. Subclassed
 * by more specific errors; use this when no more specific category
 * fits or when an `instanceof ResilienceError` check should catch the
 * whole family.
 */
export class ResilienceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResilienceError";
  }
}

/**
 * Thrown by user code to mark an error as "safe to retry". Most retry
 * policies default to retrying every error, but the predicate option
 * makes it easy to opt into the strict pattern of only retrying
 * known-transient categories — and this class is the natural sentinel.
 */
export class TransientError extends ResilienceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientError";
  }
}

/**
 * Thrown by user code (or returned by `forge/resilience/rate-limit`)
 * when a downstream dependency reports it is over capacity. The
 * optional `retryAfterMs` mirrors HTTP's `Retry-After` header so
 * retry strategies can wait the suggested interval before trying
 * again.
 */
export class RateLimitError extends ResilienceError {
  /** Suggested delay before the next attempt, when known. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "RateLimitError";
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

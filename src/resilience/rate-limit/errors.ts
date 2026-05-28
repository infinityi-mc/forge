/**
 * Errors thrown by the rate-limit policy.
 *
 * @module
 */

import { RateLimitError } from "../errors";

/**
 * Thrown by {@link rateLimit} when no token is available (or the wait
 * queue is full). Re-exports {@link RateLimitError} so consumers can
 * catch the user-throwable and the policy-thrown error with a single
 * `instanceof` check.
 *
 * Carries `retryAfterMs` populated with the estimated wait until the
 * next token refill — convenient for surfacing as an HTTP
 * `Retry-After` header.
 */
export class RateLimitedError extends RateLimitError {
  constructor(
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "RateLimitedError";
  }
}

export { RateLimitError } from "../errors";

/**
 * `retry` — retry policy implementation.
 *
 * Wraps `next` in a loop bounded by `maxAttempts`. After each failure
 * the policy consults `shouldRetry(error, attempt)` (default: retry
 * everything), waits for the configured backoff, and tries again.
 * When the loop exhausts, a {@link RetryExhaustedError} is thrown
 * with the last underlying error preserved on `cause`.
 *
 * The execution context handed to the inner operation has its
 * `attempt` field updated on every iteration so policies and user
 * code below can observe which attempt they're running under. The
 * `signal` is propagated unchanged — `retry` itself does not abort
 * anything; it just declines to schedule the next attempt if the
 * signal is already aborted.
 *
 * @module
 */

import { realClock } from "../clock";
import { withExecutionContext } from "../context";
import { buildInstruments } from "../telemetry/instrumentation";
import type {
  Clock,
  ExecutionContext,
  Operation,
} from "../types";
import { constantBackoff } from "./backoff";
import { RetryExhaustedError } from "./errors";
import type { RetryOptions, RetryPolicy } from "./types";

/**
 * Create a retry policy.
 *
 * @example
 * ```ts
 * import { retry, exponentialBackoff, combine } from "forge/resilience";
 *
 * const pipeline = combine(
 *   retry({
 *     maxAttempts: 3,
 *     backoff: exponentialBackoff({ initial: 100, max: 2_000, jitter: true }),
 *     shouldRetry: (err) => err instanceof TransientError,
 *   }),
 * );
 * ```
 */
export function retry(options: RetryOptions): RetryPolicy {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError(
      `retry: maxAttempts must be an integer >= 1, got ${options.maxAttempts}`,
    );
  }

  const maxAttempts = options.maxAttempts;
  const backoff = options.backoff ?? constantBackoff(0);
  const shouldRetry = options.shouldRetry ?? (() => true);
  const retryOn = options.retryOn;
  const clock: Clock = options.clock ?? realClock;
  const instruments = buildInstruments(options.telemetry);

  async function execute<T>(
    next: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Throw immediately if the outer caller has already cancelled —
      // no point starting a new attempt against a dead signal.
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }

      const attemptCtx =
        attempt === ctx.attempt
          ? ctx
          : withExecutionContext(ctx, { attempt });

      instruments.attempts()?.add(1, { policy: "retry" });

      try {
        const value = await next(attemptCtx);
        if (retryOn && retryOn(value, attempt)) {
          // Synthesize an error so the rest of the loop can branch
          // on it consistently. We still pass the original value
          // through `cause` in case the caller's `shouldRetry`
          // inspects it.
          const synthetic = new Error("operation returned a retryable value");
          (synthetic as { cause?: unknown }).cause = value;
          lastError = synthetic;
        } else {
          return value;
        }
      } catch (error) {
        lastError = error;
        if (!shouldRetry(error, attempt)) throw error;
      }

      // Decide whether another attempt is allowed.
      if (attempt >= maxAttempts) break;

      const delayMs = Math.max(0, backoff.delay(attempt));
      instruments.retries()?.add(1, { policy: "retry" });
      instruments.addEvent("resilience.retry.attempt", {
        attempt_number: attempt,
        delay_ms: delayMs,
        error_message:
          lastError instanceof Error ? lastError.message : String(lastError),
      });

      if (delayMs > 0) {
        await clock.sleep(delayMs, ctx.signal);
      } else if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }
    }

    throw new RetryExhaustedError(
      `retry: exhausted ${maxAttempts} attempt(s)`,
      { attempts: maxAttempts, cause: lastError },
    );
  }

  return {
    name: "retry",
    maxAttempts,
    execute,
  };
}

/**
 * `fallback` — substitute a secondary result when the primary fails.
 *
 * Runs `next(ctx)`; if it throws and the predicate accepts the error,
 * the configured fallback handler is invoked with the original error
 * and the same {@link ExecutionContext}. The handler's value becomes
 * the pipeline's value; if the handler itself throws, that error
 * propagates with the original error preserved on `cause`.
 *
 * The fallback does **not** retry — it's a one-shot alternative. Pair
 * with `retry` on the *outside* to exhaust retries first and only then
 * fall back to a degraded answer.
 *
 * @module
 */

import { buildInstruments } from "../telemetry/instrumentation";
import type { ExecutionContext, Operation } from "../types";
import type { FallbackOptions, FallbackPolicy } from "./types";

/**
 * Create a fallback policy.
 *
 * @example
 * ```ts
 * import { combine, fallback, retry } from "forge/resilience";
 *
 * const pipeline = combine(
 *   fallback({
 *     fallback: () => ({ items: [], stale: true }),
 *     shouldFallback: (err) => !(err instanceof AuthError),
 *   }),
 *   retry({ maxAttempts: 3 }),
 * );
 * ```
 */
export function fallback(options: FallbackOptions): FallbackPolicy {
  const handler = options.fallback;
  const shouldFallback = options.shouldFallback ?? (() => true);
  const instruments = buildInstruments(options.telemetry);

  async function execute<T>(
    next: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    instruments.attempts()?.add(1, { policy: "fallback" });
    try {
      return await next(ctx);
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      instruments.addEvent("resilience.fallback.triggered", {
        error_message: error instanceof Error ? error.message : String(error),
      });
      try {
        // Cast: the handler's return shape is the caller's contract,
        // not something the policy can statically verify. The pipeline's
        // generic execute<T> carries the type from the call site.
        return (await handler(error, ctx)) as T;
      } catch (fallbackError) {
        if (
          fallbackError instanceof Error &&
          (fallbackError as { cause?: unknown }).cause === undefined &&
          fallbackError !== error
        ) {
          (fallbackError as { cause?: unknown }).cause = error;
        }
        throw fallbackError;
      }
    }
  }

  return {
    name: "fallback",
    execute,
  };
}

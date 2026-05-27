/**
 * Retry policy for `forge/resilience`.
 *
 * @example
 * ```ts
 * import { combine, retry, exponentialBackoff } from "forge/resilience";
 *
 * const pipeline = combine(
 *   retry({
 *     maxAttempts: 3,
 *     backoff: exponentialBackoff({ initial: 100, max: 2_000 }),
 *   }),
 * );
 *
 * await pipeline.execute(async (ctx) => {
 *   const res = await fetch(url, { signal: ctx.signal });
 *   if (!res.ok) throw new Error("upstream failure");
 *   return res.json();
 * });
 * ```
 *
 * @module
 */

export { retry } from "./retry";
export {
  constantBackoff,
  exponentialBackoff,
  linearBackoff,
  type ExponentialBackoffOptions,
  type LinearBackoffOptions,
} from "./backoff";
export { RetryExhaustedError } from "./errors";
export type {
  RetryOptions,
  RetryPolicy,
  RetryPredicate,
  RetryValuePredicate,
} from "./types";

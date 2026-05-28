/**
 * `forge/resilience` — composable fault-tolerance for distributed
 * systems.
 *
 * The module ships {@link Policy} primitives (retry, timeout, …) that
 * compose into {@link Pipeline}s via {@link combine}. Every operation
 * receives an {@link ExecutionContext} carrying a native
 * {@link AbortSignal}: pass it to `fetch`, `bun:sqlite`, or any other
 * cooperating I/O so a timeout actually cancels the underlying work
 * rather than letting it leak in the background.
 *
 * This entry-point exposes the core types plus the policies that
 * shipped in PR A (retry + timeout). Stateful policies
 * (circuit-breaker, rate-limit, bulkhead) and advanced patterns
 * (fallback, hedge, Result-based no-throw API) follow in PR B and
 * PR C.
 *
 * @example Minimal usage
 * ```ts
 * import { combine, retry, timeout, exponentialBackoff } from "forge/resilience";
 *
 * const pipeline = combine(
 *   retry({
 *     maxAttempts: 3,
 *     backoff: exponentialBackoff({ initial: 100, max: 2_000 }),
 *   }),
 *   timeout({ ms: 2_000 }),
 * );
 *
 * const data = await pipeline.execute(async (ctx) => {
 *   const res = await fetch(url, { signal: ctx.signal });
 *   return res.json();
 * });
 * ```
 *
 * @module
 */

export { combine } from "./pipeline";
export { realClock } from "./clock";
export {
  RateLimitError,
  ResilienceError,
  TransientError,
} from "./errors";
export { err, isErr, isOk, ok } from "./result";
export type { Err, Ok, Result } from "./result";
export type {
  BackoffStrategy,
  Clock,
  ExecutionContext,
  Operation,
  Pipeline,
  Policy,
} from "./types";

// Retry
export {
  RetryExhaustedError,
  constantBackoff,
  exponentialBackoff,
  linearBackoff,
  retry,
  type ExponentialBackoffOptions,
  type LinearBackoffOptions,
  type RetryOptions,
  type RetryPolicy,
  type RetryPredicate,
  type RetryValuePredicate,
} from "./retry";

// Timeout
export {
  TimeoutError,
  timeout,
  type TimeoutOptions,
  type TimeoutPolicy,
  type TimeoutStrategy,
} from "./timeout";

// Circuit breaker
export {
  CircuitOpenError,
  circuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerPolicy,
  type CircuitState,
  type CircuitWindow,
} from "./circuit-breaker";

// Rate limit
export {
  RateLimitedError,
  rateLimit,
  type RateLimitAlgorithm,
  type RateLimitMode,
  type RateLimitOptions,
  type RateLimitPolicy,
} from "./rate-limit";

// Bulkhead
export {
  BulkheadFullError,
  bulkhead,
  type BulkheadOptions,
  type BulkheadPolicy,
} from "./bulkhead";

// Fallback
export {
  fallback,
  type FallbackHandler,
  type FallbackOptions,
  type FallbackPolicy,
  type FallbackPredicate,
} from "./fallback";

// Hedge
export {
  HedgeCancelledError,
  hedge,
  type HedgeOptions,
  type HedgePolicy,
} from "./hedge";

// Telemetry hook surface
export type { ResilienceTelemetry } from "./telemetry/instrumentation";

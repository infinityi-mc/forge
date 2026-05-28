/**
 * Types for `forge/resilience/rate-limit`.
 *
 * @module
 */

import type {
  Clock,
  ExecutionContext,
  Operation,
  Policy,
} from "../types";
import type { ResilienceTelemetry } from "../telemetry/instrumentation";

/**
 * Behaviour when a token is not currently available.
 *
 * - `throw`: reject immediately with a `RateLimitedError` (synthesized
 *   from {@link RateLimitError}) carrying a `retryAfterMs` hint.
 * - `wait`: queue the request and resume once a token is available.
 *   Respects the operation's `AbortSignal` so an outer `timeout`
 *   cancellation drops the wait.
 */
export type RateLimitMode = "throw" | "wait";

/**
 * Rate-limit algorithm. Token-bucket allows short bursts up to
 * `burst`; sliding-window enforces a strict request-per-window cap.
 */
export type RateLimitAlgorithm =
  | {
      readonly kind: "token-bucket";
      /** Tokens added per second. */
      readonly tokensPerSecond: number;
      /** Maximum tokens the bucket can hold. Defaults to `tokensPerSecond`. */
      readonly burst?: number;
    }
  | {
      readonly kind: "sliding-window";
      /** Maximum number of requests permitted in any `windowMs`. */
      readonly limit: number;
      /** Window duration in milliseconds. */
      readonly windowMs: number;
    };

/**
 * Options for {@link rateLimit}.
 */
export interface RateLimitOptions {
  /** Algorithm used to decide whether to admit a call. */
  algorithm: RateLimitAlgorithm;
  /** Behaviour when no token is available. Defaults to `"throw"`. */
  mode?: RateLimitMode;
  /**
   * Maximum number of callers parked simultaneously in `wait` mode.
   * Defaults to `Infinity` (no cap). When exceeded, excess callers
   * are rejected as if `mode` were `"throw"`.
   */
  maxWaiters?: number;
  /** Telemetry hook. Standalone limiters emit nothing when omitted. */
  telemetry?: ResilienceTelemetry;
  /** Override the clock source for tests. Defaults to `realClock`. */
  clock?: Clock;
}

/**
 * Rate-limit policy returned by {@link rateLimit}. Exposes the
 * underlying state (`availableTokens`, `pending`) for tests and
 * for operator dashboards.
 */
export interface RateLimitPolicy extends Policy {
  readonly name: "rate-limit";
  /**
   * Approximate number of admissions currently available. For
   * token-bucket this is the bucket level rounded down; for
   * sliding-window it's `limit - active`.
   */
  readonly availableTokens: number;
  /** Number of callers currently waiting on a token. */
  readonly pending: number;
  /**
   * Lower-level execute helper. Same signature as {@link Policy.execute}
   * — exposed for direct unit testing.
   */
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

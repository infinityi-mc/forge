/**
 * Types for `forge/resilience/circuit-breaker`.
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
 * Lifecycle states of a circuit breaker.
 *
 * - `closed`: normal operation; calls are forwarded to the operation.
 * - `open`: rejecting calls immediately with {@link CircuitOpenError}
 *   until `resetTimeoutMs` elapses.
 * - `half-open`: a bounded number of probe calls are allowed through;
 *   the next outcome decides whether to close (success) or reopen
 *   (failure).
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Sliding-window configuration. The breaker counts the last `size`
 * outcomes (count-window) or the outcomes within the last `durationMs`
 * (time-window) when computing whether to trip.
 */
export type CircuitWindow =
  | { readonly kind: "count"; readonly size: number }
  | { readonly kind: "time"; readonly durationMs: number };

/**
 * Options for {@link circuitBreaker}.
 */
export interface CircuitBreakerOptions {
  /**
   * Number of failures (when `>= 1`) or failure ratio (when in `(0, 1)`)
   * required to transition from `closed` to `open`. Ratios require at
   * least {@link CircuitBreakerOptions.minimumRequests} samples in the
   * window before they can trip — otherwise a single failure with one
   * sample would always cross any ratio.
   */
  failureThreshold: number;
  /**
   * Minimum number of samples in the window before a ratio threshold
   * can trip. Ignored when `failureThreshold >= 1`. Defaults to
   * `failureThreshold`'s implied minimum (`Math.ceil(1 / failureThreshold)`).
   */
  minimumRequests?: number;
  /**
   * Sampling window. Defaults to a count-window of 10 — pick a
   * time-window for low-volume calls so a stale failure can't keep the
   * breaker open indefinitely.
   */
  window?: CircuitWindow;
  /**
   * How long to stay in `open` before transitioning to `half-open`
   * (ms). The check is lazy: the next `execute` after the deadline
   * triggers the transition.
   */
  resetTimeoutMs: number;
  /**
   * Maximum number of probe calls allowed in flight while in
   * `half-open`. Defaults to `1` so the breaker is genuinely probing,
   * not stampeding. Additional calls are rejected with
   * {@link CircuitOpenError}.
   */
  halfOpenMaxAttempts?: number;
  /**
   * Decide whether an error counts as a failure (vs. a "user error"
   * that shouldn't trip the breaker). Defaults to "every error trips".
   * Returning `false` records a *success* in the window — same as if
   * the operation had resolved.
   */
  shouldTrip?: (error: unknown) => boolean;
  /** Telemetry hook. Standalone breakers emit nothing when omitted. */
  telemetry?: ResilienceTelemetry;
  /** Override the clock source for tests. Defaults to `realClock`. */
  clock?: Clock;
}

/**
 * Circuit breaker policy returned by {@link circuitBreaker}. Carries
 * lifecycle inspectors (`forceOpen` / `forceClosed`) and a `state`
 * getter so consumers (or tests) can observe the current state.
 */
export interface CircuitBreakerPolicy extends Policy {
  readonly name: "circuit-breaker";
  /** Current breaker state. */
  readonly state: CircuitState;
  /**
   * Force the breaker into `open` regardless of its window. Useful for
   * incident response (cut traffic to a known-bad dependency without a
   * redeploy).
   */
  forceOpen(): void;
  /**
   * Force the breaker back to `closed`, clearing the window. Useful
   * when an operator has manually confirmed the dependency is healthy.
   */
  forceClosed(): void;
  /** Clear the window and return to `closed` with no recorded history. */
  reset(): void;
  /**
   * Lower-level execute helper. Same signature as {@link Policy.execute}
   * — exposed so tests can invoke the breaker directly.
   */
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

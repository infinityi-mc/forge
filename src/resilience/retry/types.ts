/**
 * Types for `forge/resilience/retry`.
 *
 * @module
 */

import type {
  BackoffStrategy,
  Clock,
  ExecutionContext,
  Operation,
  Policy,
} from "../types";
import type { ResilienceTelemetry } from "../telemetry/instrumentation";

/**
 * Predicate consulted after a failure. Return `true` to keep retrying,
 * `false` to give up and throw the original error.
 *
 * `attempt` is the 1-based number of the attempt that just failed —
 * the next attempt would be `attempt + 1`. `error` is whatever the
 * operation threw.
 */
export type RetryPredicate = (error: unknown, attempt: number) => boolean;

/**
 * Predicate consulted on a *successful* result. Return `true` to
 * retry anyway (treating the value as a recoverable failure). Use
 * when a 200 response can still carry an error payload.
 */
export type RetryValuePredicate<T> = (value: T, attempt: number) => boolean;

/**
 * Options for {@link retry}.
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts including the first one. Must be `>=
   * 1`. A `maxAttempts` of `1` means no retries — useful for
   * conditionally enabling retries via configuration without
   * restructuring the pipeline.
   */
  maxAttempts: number;
  /**
   * Backoff strategy. Defaults to {@link constantBackoff} with
   * `0ms` — i.e. retry immediately. Use {@link exponentialBackoff}
   * for the typical production setting.
   */
  backoff?: BackoffStrategy;
  /**
   * Decide whether to retry a given error. Defaults to "retry every
   * error". Returning `false` short-circuits the retry loop and
   * re-throws the original error.
   */
  shouldRetry?: RetryPredicate;
  /**
   * Optional value-level predicate. When set and the operation
   * resolves with a value the predicate accepts (returns `true`),
   * the result is treated as a failure and the loop runs again with
   * a synthesized error.
   */
  retryOn?: RetryValuePredicate<unknown>;
  /** Telemetry hook. When omitted, retry emits nothing. */
  telemetry?: ResilienceTelemetry;
  /** Override the clock source for tests. Defaults to `realClock`. */
  clock?: Clock;
}

/**
 * Retry policy returned by {@link retry}. Same interface as
 * {@link Policy} — exported as its own name so consumers can type
 * their policy slots specifically when useful.
 */
export interface RetryPolicy extends Policy {
  readonly name: "retry";
  /** The effective options used by this policy. */
  readonly maxAttempts: number;
  /**
   * Lower-level helper that runs `op` inside the retry loop without
   * needing an outer pipeline. Useful in tests.
   */
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

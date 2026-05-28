/**
 * Types for `forge/resilience/fallback`.
 *
 * @module
 */

import type {
  ExecutionContext,
  Operation,
  Policy,
} from "../types";
import type { ResilienceTelemetry } from "../telemetry/instrumentation";

/**
 * Predicate consulted after the primary operation fails. Return `true`
 * to run the fallback, `false` to rethrow the original error. Defaults
 * to "fallback on every error".
 */
export type FallbackPredicate = (error: unknown) => boolean;

/**
 * Fallback handler. Receives the underlying error and the same
 * {@link ExecutionContext} the primary saw. The return type is
 * intentionally `unknown` so a single policy can sit in any pipeline —
 * the caller asserts via `pipeline.execute<T>` that the fallback
 * produces the type the primary would have. Throwing inside the
 * handler propagates the new error (with the original kept on `cause`).
 */
export type FallbackHandler = (
  error: unknown,
  ctx: ExecutionContext,
) => Promise<unknown> | unknown;

/**
 * Options for {@link fallback}.
 */
export interface FallbackOptions {
  /**
   * Fallback operation invoked when the primary fails and
   * `shouldFallback` accepts the error.
   */
  fallback: FallbackHandler;
  /**
   * Decide whether a given failure should trigger the fallback.
   * Defaults to "every error". Returning `false` short-circuits and
   * rethrows the original error.
   */
  shouldFallback?: FallbackPredicate;
  /** Telemetry hook. When omitted, fallback emits nothing. */
  telemetry?: ResilienceTelemetry;
}

/**
 * Fallback policy returned by {@link fallback}.
 */
export interface FallbackPolicy extends Policy {
  readonly name: "fallback";
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

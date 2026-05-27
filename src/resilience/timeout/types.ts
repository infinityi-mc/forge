/**
 * Types for `forge/resilience/timeout`.
 *
 * @module
 */

import type { Clock, Policy } from "../types";
import type { ResilienceTelemetry } from "../telemetry/instrumentation";

/**
 * Timeout enforcement strategy.
 *
 * - `optimistic` — when the deadline fires, abort the inner signal
 *   immediately and reject with a {@link TimeoutError}. The operation
 *   continues running in the background until it observes the abort
 *   (or runs to completion, discarded). This is the right choice for
 *   I/O that respects `AbortSignal` — `fetch`, `bun:sqlite` with a
 *   signal, anything you control.
 * - `pessimistic` — when the deadline fires, abort the inner signal
 *   *and* wait for the operation to settle before rejecting. Use for
 *   work that may not honor the abort (third-party libraries, native
 *   code) where you'd rather know the operation finished than fire a
 *   reject early.
 *
 * "Optimistic" matches the spec's terminology in §B.
 */
export type TimeoutStrategy = "optimistic" | "pessimistic";

export interface TimeoutOptions {
  /** Deadline in milliseconds. Must be `>= 0`. */
  ms: number;
  /** Defaults to `"optimistic"`. */
  strategy?: TimeoutStrategy;
  /** Telemetry hook. When omitted, timeout emits nothing. */
  telemetry?: ResilienceTelemetry;
  /** Override the clock source for tests. Defaults to `realClock`. */
  clock?: Clock;
}

export interface TimeoutPolicy extends Policy {
  readonly name: "timeout";
  readonly ms: number;
  readonly strategy: TimeoutStrategy;
}

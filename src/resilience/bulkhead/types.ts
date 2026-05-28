/**
 * Types for `forge/resilience/bulkhead`.
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
 * Options for {@link bulkhead}.
 */
export interface BulkheadOptions {
  /**
   * Maximum number of operations allowed to run concurrently. Must be
   * an integer `>= 1`. Calls beyond this limit either queue (when the
   * queue has spare capacity) or fail fast with
   * {@link BulkheadFullError}.
   */
  maxConcurrent: number;
  /**
   * Bounded wait queue for callers when `maxConcurrent` is saturated.
   * Defaults to `0` — no queueing, fail fast.
   */
  maxQueue?: number;
  /** Telemetry hook. Standalone bulkheads emit nothing when omitted. */
  telemetry?: ResilienceTelemetry;
}

/**
 * Bulkhead policy returned by {@link bulkhead}. Exposes the current
 * `active` and `queued` counts for operator dashboards and tests.
 */
export interface BulkheadPolicy extends Policy {
  readonly name: "bulkhead";
  /** Number of operations currently running. */
  readonly active: number;
  /** Number of callers currently waiting for a slot. */
  readonly queued: number;
  /**
   * Lower-level execute helper. Same signature as {@link Policy.execute}
   * — exposed for direct unit testing.
   */
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

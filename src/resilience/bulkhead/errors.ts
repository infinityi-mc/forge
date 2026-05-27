/**
 * Errors thrown by the bulkhead policy.
 *
 * @module
 */

import { ResilienceError } from "../errors";

/**
 * Thrown when a bulkhead has no execution slots free AND its queue is
 * also full. Carries the saturation level at the moment of rejection
 * so dashboards can correlate spikes.
 */
export class BulkheadFullError extends ResilienceError {
  /** Number of operations executing when the rejection occurred. */
  readonly active: number;
  /** Configured concurrency limit. */
  readonly maxConcurrent: number;
  /** Number of callers parked in the queue when the rejection occurred. */
  readonly queued: number;
  /** Configured queue capacity. */
  readonly maxQueue: number;

  constructor(
    message: string,
    options: ErrorOptions & {
      active: number;
      maxConcurrent: number;
      queued: number;
      maxQueue: number;
    },
  ) {
    super(message, options);
    this.name = "BulkheadFullError";
    this.active = options.active;
    this.maxConcurrent = options.maxConcurrent;
    this.queued = options.queued;
    this.maxQueue = options.maxQueue;
  }
}

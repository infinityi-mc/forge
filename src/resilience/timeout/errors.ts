/**
 * Errors thrown by `forge/resilience/timeout`.
 *
 * @module
 */

import { ResilienceError } from "../errors";
import type { TimeoutStrategy } from "./types";

/**
 * Thrown when an operation does not settle within the configured
 * deadline. The {@link AbortSignal} held by the operation is aborted
 * (with this error as the `reason`) so cooperating I/O cancels at
 * the socket level.
 */
export class TimeoutError extends ResilienceError {
  readonly timeoutMs: number;
  readonly strategy: TimeoutStrategy;

  constructor(
    message: string,
    options: ErrorOptions & { timeoutMs: number; strategy: TimeoutStrategy },
  ) {
    super(message, options);
    this.name = "TimeoutError";
    this.timeoutMs = options.timeoutMs;
    this.strategy = options.strategy;
  }
}

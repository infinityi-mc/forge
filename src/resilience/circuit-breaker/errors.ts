/**
 * Errors thrown by the circuit-breaker policy.
 *
 * @module
 */

import { ResilienceError } from "../errors";
import type { CircuitState } from "./types";

/**
 * Thrown when a call is rejected by an `open` (or saturated
 * `half-open`) breaker. Carries the breaker's current state and, when
 * known, the wall-clock time at which it became open — handy for
 * computing "retry-after" hints in upstream error pages.
 */
export class CircuitOpenError extends ResilienceError {
  /** Breaker state observed at the time the call was rejected. */
  readonly state: CircuitState;
  /** Wall-clock millisecond timestamp when the breaker last opened. */
  readonly openedAt?: number;
  /**
   * Wall-clock millisecond timestamp at which the breaker will next be
   * eligible to transition to `half-open`. `undefined` when the
   * breaker has been forced open with no automatic reset.
   */
  readonly retryAt?: number;

  constructor(
    message: string,
    options: ErrorOptions & {
      state: CircuitState;
      openedAt?: number;
      retryAt?: number;
    },
  ) {
    super(message, options);
    this.name = "CircuitOpenError";
    this.state = options.state;
    if (options.openedAt !== undefined) this.openedAt = options.openedAt;
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
  }
}

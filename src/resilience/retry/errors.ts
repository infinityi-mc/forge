/**
 * Errors thrown by `forge/resilience/retry`.
 *
 * @module
 */

import { ResilienceError } from "../errors";

/**
 * Thrown after the configured `maxAttempts` is reached without
 * success. `cause` is the last error raised by the operation;
 * `attempts` is the total number of attempts made.
 */
export class RetryExhaustedError extends ResilienceError {
  readonly attempts: number;

  constructor(
    message: string,
    options: ErrorOptions & { attempts: number },
  ) {
    super(message, options);
    this.name = "RetryExhaustedError";
    this.attempts = options.attempts;
  }
}

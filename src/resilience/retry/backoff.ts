/**
 * Backoff strategies for {@link retry}.
 *
 * Every strategy is a plain {@link BackoffStrategy} — a single
 * `delay(attempt)` method that returns the milliseconds to wait
 * *before the next attempt*. Strategies are stateless: the same
 * instance is safe to share across pipelines and across concurrent
 * executions.
 *
 * @example Exponential with jitter (the default-recommendation)
 * ```ts
 * const backoff = exponentialBackoff({ initial: 100, max: 2_000, jitter: true });
 * backoff.delay(1); // ~100ms (jittered)
 * backoff.delay(2); // ~200ms (jittered)
 * backoff.delay(3); // ~400ms (jittered)
 * backoff.delay(99); // capped at 2_000ms
 * ```
 *
 * @module
 */

import type { BackoffStrategy } from "../types";

/** Constant delay. Use for very fast paths where any wait is fine. */
export function constantBackoff(delayMs: number): BackoffStrategy {
  const ms = Math.max(0, delayMs);
  return { delay: () => ms };
}

/**
 * Linear growth: `delay = initial * attempt`, capped at `max`.
 * Jitter is optional; defaults to off.
 */
export interface LinearBackoffOptions {
  initial: number;
  max?: number;
  jitter?: boolean;
}

export function linearBackoff(options: LinearBackoffOptions): BackoffStrategy {
  const initial = Math.max(0, options.initial);
  const max = options.max !== undefined ? Math.max(initial, options.max) : Number.POSITIVE_INFINITY;
  const jitter = options.jitter ?? false;
  return {
    delay(attempt: number) {
      const raw = Math.min(max, initial * Math.max(1, attempt));
      return jitter ? applyFullJitter(raw) : raw;
    },
  };
}

/**
 * Exponential growth: `delay = initial * 2^(attempt - 1)`, capped at
 * `max`. **Jitter defaults to `true`** because un-jittered
 * exponential backoff produces synchronized retry storms ("thundering
 * herd") whenever many clients fail at the same instant — the spec
 * (§A) calls this out as mandatory.
 */
export interface ExponentialBackoffOptions {
  initial: number;
  max?: number;
  /** Multiplier between attempts. Defaults to `2`. */
  factor?: number;
  /** Apply AWS-style full jitter. Defaults to `true`. */
  jitter?: boolean;
}

export function exponentialBackoff(
  options: ExponentialBackoffOptions,
): BackoffStrategy {
  const initial = Math.max(0, options.initial);
  const max = options.max !== undefined ? Math.max(initial, options.max) : Number.POSITIVE_INFINITY;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  return {
    delay(attempt: number) {
      const exponent = Math.max(0, attempt - 1);
      const raw = Math.min(max, initial * Math.pow(factor, exponent));
      return jitter ? applyFullJitter(raw) : raw;
    },
  };
}

/**
 * Full jitter (Marc Brooker / AWS exponential-backoff-and-jitter
 * paper): pick a uniform random number in `[0, base]`. Best
 * generally-applicable choice for spreading retry pressure.
 */
function applyFullJitter(base: number): number {
  if (base <= 0) return 0;
  return Math.random() * base;
}

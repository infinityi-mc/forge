/**
 * Core types for `forge/resilience`.
 *
 * Every policy in the module — retry, timeout, circuit-breaker, etc. —
 * implements {@link Policy}, and policies compose into a {@link Pipeline}
 * via {@link combine}. The operation receives an
 * {@link ExecutionContext} that exposes an `AbortSignal`, the attempt
 * number, and the active telemetry context.
 *
 * The shape mirrors `forge/telemetry/log`'s middleware contract: a
 * policy wraps a "next" execution the same way a `LogMiddleware` wraps
 * the next exporter. The composition order is identical
 * (outermost-first).
 *
 * @module
 */

import type { TelemetryContext } from "../telemetry/context/types";
import type { ResilienceError } from "./errors";
import type { Result } from "./result";

/**
 * The data passed to every executed operation. Carries an
 * {@link AbortSignal} that policies can trigger (`timeout`, `hedge`)
 * so cooperating I/O is actually cancelled, the current `attempt`
 * counter (incremented by `retry`), and — when one is active — the
 * telemetry context from `forge/telemetry/context`.
 */
export interface ExecutionContext {
  /**
   * AbortSignal scoped to the current execution. Pass it to `fetch()`,
   * DB drivers, or any other cooperating I/O so a timeout or hedge
   * loser is actually cancelled at the socket level — never leak a
   * pending promise.
   */
  readonly signal: AbortSignal;
  /**
   * 1-based attempt counter. `retry` increments this on each retry;
   * other policies pass it through unchanged.
   */
  readonly attempt: number;
  /**
   * Active telemetry context at the time the pipeline started, if
   * any. Read at the entry of `pipeline.execute()` from
   * {@link currentContext} — not re-read on every nested policy.
   */
  readonly context?: TelemetryContext;
}

/**
 * The unit of work a {@link Pipeline} runs. Receives the execution
 * context and returns synchronously or asynchronously.
 */
export type Operation<T> = (ctx: ExecutionContext) => Promise<T> | T;

/**
 * A single resilience rule. Policies wrap a "next" operation in much
 * the same way `LogMiddleware` wraps the next exporter — and compose
 * exactly the same way under {@link combine}.
 *
 * Stateful policies (circuit-breaker, rate-limit, bulkhead) hang
 * additional inspector / lifecycle methods off this base interface.
 */
export interface Policy {
  /** Stable identifier for the policy. Used in span events and errors. */
  readonly name: string;
  /**
   * Run `op` under the policy's rules. Receives the "next" operation
   * (which, for outer policies, is the inner pipeline) and a context
   * to thread through. The implementation typically calls `next(ctx)`
   * one or more times.
   */
  execute<T>(next: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

/**
 * A composition of zero or more {@link Policy} instances. Build with
 * {@link combine}; run with {@link Pipeline.execute} (throwing) or
 * {@link Pipeline.executeResult} (no-throw).
 */
export interface Pipeline {
  /**
   * Run `op` through every wrapped policy. Throws whichever error the
   * outermost policy lets escape.
   */
  execute<T>(op: Operation<T>): Promise<T>;
  /**
   * Run `op` through every wrapped policy without throwing. The
   * returned {@link Result} surfaces the originating
   * {@link ResilienceError} on the failure branch.
   */
  executeResult<T>(op: Operation<T>): Promise<Result<T, ResilienceError>>;
}

/**
 * Monotonic clock injected into policies that schedule work — `retry`
 * for backoffs, `timeout` for deadlines. Tests substitute a
 * deterministic `TestClock` from `forge/resilience/testing`.
 */
export interface Clock {
  /** Current wall-clock millisecond timestamp. */
  now(): number;
  /**
   * Resolve after at least `ms` milliseconds, or reject with the
   * signal's reason when aborted before the deadline. `ms <= 0`
   * resolves on the next microtask.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Strategy that produces a delay (ms) before the next retry attempt.
 * `attempt` is the 1-based number of the attempt that just failed —
 * the next attempt is `attempt + 1`.
 */
export interface BackoffStrategy {
  /** Return the delay (ms) before attempt `attempt + 1`. */
  delay(attempt: number): number;
}

/**
 * Types for `forge/resilience/hedge`.
 *
 * @module
 */

import type {
  Clock,
  ExecutionContext,
  Operation,
  Policy,
} from "../types";
import type { ResilienceTelemetry } from "../telemetry/instrumentation";

/**
 * Options for {@link hedge}.
 */
export interface HedgeOptions {
  /**
   * Delay (ms) before each successive hedged attempt is fired. The
   * first attempt starts immediately; the second after `delay` ms, the
   * third after another `delay` ms, and so on. Must be `>= 0`.
   */
  delay: number;
  /**
   * Maximum number of concurrent attempts, including the first. Must
   * be an integer `>= 1`. Setting `1` makes the policy a no-op pass-
   * through; `2` is the classic "fire a second request after a delay"
   * pattern.
   */
  maxHedgedAttempts: number;
  /** Telemetry hook. When omitted, hedge emits nothing. */
  telemetry?: ResilienceTelemetry;
  /** Clock used to schedule the delay between attempts. */
  clock?: Clock;
}

/**
 * Hedge policy returned by {@link hedge}. Same interface as
 * {@link Policy}; exposed as its own name so consumers can type policy
 * slots specifically.
 */
export interface HedgePolicy extends Policy {
  readonly name: "hedge";
  execute<T>(op: Operation<T>, ctx: ExecutionContext): Promise<T>;
}

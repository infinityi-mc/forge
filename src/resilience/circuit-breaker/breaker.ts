/**
 * `circuitBreaker` — three-state breaker (closed / open / half-open)
 * that fails fast when a dependency is unhealthy.
 *
 * Failures are recorded in a sliding window (count- or time-based) so
 * the trip decision is not skewed by long-ago history. When the
 * configured threshold is exceeded the breaker transitions to `open`
 * and rejects every subsequent call with {@link CircuitOpenError}
 * until `resetTimeoutMs` elapses. The first call after the cool-down
 * advances the breaker to `half-open`: it lets up to
 * `halfOpenMaxAttempts` probes through and reads the next outcome —
 * success closes the breaker, failure reopens it.
 *
 * The instance is *explicit*: no global registry, no per-process
 * singletons. If you need a breaker per tenant, hold a
 * `Map<string, CircuitBreakerPolicy>` yourself.
 *
 * @module
 */

import { realClock } from "../clock";
import { buildInstruments } from "../telemetry/instrumentation";
import type { Clock, ExecutionContext, Operation } from "../types";
import { CircuitOpenError } from "./errors";
import {
  CountWindow,
  TimeWindow,
  type Outcome,
  type SlidingWindow,
} from "./sliding-window";
import type {
  CircuitBreakerOptions,
  CircuitBreakerPolicy,
  CircuitState,
} from "./types";

const STATE_CODE: Record<CircuitState, number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

/**
 * Create a circuit breaker policy.
 *
 * @example
 * ```ts
 * import { circuitBreaker, combine } from "forge/resilience";
 *
 * const breaker = circuitBreaker({
 *   failureThreshold: 5,
 *   resetTimeoutMs: 30_000,
 * });
 *
 * const pipeline = combine(breaker);
 * await pipeline.execute(async (ctx) => fetch(url, { signal: ctx.signal }));
 * ```
 */
export function circuitBreaker(
  options: CircuitBreakerOptions,
): CircuitBreakerPolicy {
  if (
    !Number.isFinite(options.failureThreshold) ||
    options.failureThreshold <= 0
  ) {
    throw new RangeError(
      `circuitBreaker: failureThreshold must be > 0, got ${options.failureThreshold}`,
    );
  }
  if (!Number.isFinite(options.resetTimeoutMs) || options.resetTimeoutMs < 0) {
    throw new RangeError(
      `circuitBreaker: resetTimeoutMs must be a non-negative finite number, got ${options.resetTimeoutMs}`,
    );
  }

  const failureThreshold = options.failureThreshold;
  const isRatio = failureThreshold > 0 && failureThreshold < 1;
  const minimumRequests =
    options.minimumRequests ??
    (isRatio ? Math.ceil(1 / failureThreshold) : failureThreshold);
  const resetTimeoutMs = options.resetTimeoutMs;
  const halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
  if (!Number.isInteger(halfOpenMaxAttempts) || halfOpenMaxAttempts < 1) {
    throw new RangeError(
      `circuitBreaker: halfOpenMaxAttempts must be an integer >= 1, got ${halfOpenMaxAttempts}`,
    );
  }
  const shouldTrip = options.shouldTrip ?? (() => true);
  const clock: Clock = options.clock ?? realClock;
  const instruments = buildInstruments(options.telemetry);

  const windowConfig = options.window ?? { kind: "count", size: 10 };
  const window: SlidingWindow =
    windowConfig.kind === "count"
      ? new CountWindow(windowConfig.size)
      : new TimeWindow(windowConfig.durationMs);

  let state: CircuitState = "closed";
  let openedAt: number | undefined;
  let halfOpenInFlight = 0;

  function reportState(): void {
    instruments.circuitState()?.record(STATE_CODE[state], {
      policy: "circuit-breaker",
      state,
    });
  }

  function transition(next: CircuitState, now: number): void {
    if (state === next) return;
    const from = state;
    state = next;
    if (next === "open") {
      openedAt = now;
    } else {
      openedAt = undefined;
    }
    if (next !== "half-open") {
      halfOpenInFlight = 0;
    }
    instruments.addEvent("resilience.circuit.state_change", {
      from_state: from,
      to_state: next,
    });
    reportState();
  }

  function recordOutcome(outcome: Outcome, now: number): void {
    window.record(outcome, now);
  }

  function maybeTrip(now: number): boolean {
    const samples = window.samples(now);
    const failures = window.failures(now);
    if (isRatio) {
      if (samples < minimumRequests) return false;
      return failures / samples >= failureThreshold;
    }
    return failures >= failureThreshold;
  }

  // Seed the gauge so observers can see the initial state without
  // waiting for the first call.
  reportState();

  async function execute<T>(
    op: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    const now = clock.now();

    if (state === "open") {
      const retryAt =
        openedAt !== undefined ? openedAt + resetTimeoutMs : undefined;
      // Lazy half-open transition: the first call after the cool-down
      // is converted into a probe.
      if (retryAt !== undefined && now >= retryAt) {
        transition("half-open", now);
      } else {
        throw new CircuitOpenError(`circuit-breaker: breaker is open`, {
          state,
          openedAt,
          retryAt,
        });
      }
    }

    if (state === "half-open") {
      if (halfOpenInFlight >= halfOpenMaxAttempts) {
        throw new CircuitOpenError(
          `circuit-breaker: half-open probe slots exhausted`,
          { state, openedAt, retryAt: undefined },
        );
      }
      halfOpenInFlight++;
    }

    instruments.attempts()?.add(1, { policy: "circuit-breaker", state });

    try {
      const value = await op(ctx);
      const after = clock.now();
      if (state === "half-open") {
        halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
        window.clear();
        transition("closed", after);
      } else {
        recordOutcome("success", after);
      }
      return value;
    } catch (error) {
      const after = clock.now();
      const isFailure = shouldTrip(error);
      if (state === "half-open") {
        halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
        if (isFailure) {
          window.clear();
          transition("open", after);
        } else {
          // Treat as success — the dependency answered, just not with
          // an answer that should trip the breaker.
          window.clear();
          transition("closed", after);
        }
      } else if (isFailure) {
        recordOutcome("failure", after);
        if (maybeTrip(after)) transition("open", after);
      } else {
        recordOutcome("success", after);
      }
      throw error;
    }
  }

  function forceOpen(): void {
    const now = clock.now();
    if (state === "open") {
      // Operator intent should extend the cool-down from the manual
      // force-open time, not silently keep counting from the original
      // trip. `transition("open")` would no-op because the state is
      // unchanged, so refresh the timestamp explicitly.
      openedAt = now;
      halfOpenInFlight = 0;
      reportState();
      return;
    }
    transition("open", now);
  }

  function forceClosed(): void {
    const now = clock.now();
    window.clear();
    transition("closed", now);
  }

  function reset(): void {
    window.clear();
    transition("closed", clock.now());
  }

  return {
    name: "circuit-breaker",
    get state() {
      return state;
    },
    forceOpen,
    forceClosed,
    reset,
    execute,
  };
}

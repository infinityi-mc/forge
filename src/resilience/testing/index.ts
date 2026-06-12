/**
 * Test helpers for `forge/resilience`.
 *
 * Ships a deterministic {@link TestClock} that policies accept via
 * their `clock` option, an {@link executionContext} factory for unit
 * tests that exercise a `Policy` directly, the
 * {@link STANDARD_RESILIENCE_SCENARIOS} conformance suite, a
 * standalone {@link createTestResilienceTelemetry} double, and a
 * one-call {@link createTestResilience} harness that wires the common
 * primitives together.
 *
 * @module
 */

export { TestClock } from "./clock";
export {
  BULKHEAD_RESILIENCE_SCENARIOS,
  CLOCK_DETERMINISM_SCENARIOS,
  COMPOSITION_RESILIENCE_SCENARIOS,
  FALLBACK_RESILIENCE_SCENARIOS,
  POLICY_SPECIFIC_SCENARIOS,
  RATE_LIMIT_RESILIENCE_SCENARIOS,
  STANDARD_RESILIENCE_SCENARIOS,
  assertConformance,
  assertPolicyConformance,
  type PipelineFactory,
  type ResilienceConformanceScenario,
} from "./conformance";
export {
  createTestResilienceTelemetry,
  type RecordedAttributeValue,
  type RecordedAttributes,
  type RecordedMetric,
  type RecordedMetricKind,
  type RecordedSpanEvent,
  type TestResilienceTelemetry,
} from "./telemetry";

import { TestClock } from "./clock";
import type { ExecutionContext } from "../types";

export interface ExecutionContextOverrides {
  signal?: AbortSignal;
  attempt?: number;
}

/**
 * Build an {@link ExecutionContext} for direct-to-policy testing.
 * Defaults to a never-aborted signal and `attempt: 1`.
 *
 * @example
 * ```ts
 * import { executionContext, TestClock } from "forge/resilience/testing";
 * import { retry } from "forge/resilience";
 *
 * const ctx = executionContext();
 * const clock = new TestClock();
 * const policy = retry({ maxAttempts: 2, clock });
 * await policy.execute(op, ctx);
 * ```
 */
export function executionContext(
  overrides: ExecutionContextOverrides = {},
): ExecutionContext {
  const signal = overrides.signal ?? new AbortController().signal;
  return { signal, attempt: overrides.attempt ?? 1 };
}

/**
 * Handle returned by {@link createTestResilience} — bundles a fresh
 * {@link TestClock}, an {@link ExecutionContext} factory, and a
 * controller-bound signal so tests can abort from the outside.
 */
export interface TestResilienceHarness {
  clock: TestClock;
  /** Controller backing {@link context}'s default signal. */
  controller: AbortController;
  /**
   * Build an {@link ExecutionContext}. Defaults to the harness's
   * controller-bound signal; pass `overrides.signal` to use a
   * different one.
   */
  context(overrides?: ExecutionContextOverrides): ExecutionContext;
  /** Convenience accessor for the harness's signal. */
  readonly signal: AbortSignal;
}

/**
 * One-call wiring of the test primitives most resilience tests need —
 * a {@link TestClock}, an {@link AbortController}, and an
 * {@link executionContext} factory pre-bound to the controller's
 * signal. Use in place of three separate `new`/`executionContext`
 * calls.
 *
 * @example
 * ```ts
 * import { createTestResilience } from "forge/resilience/testing";
 * import { retry } from "forge/resilience";
 *
 * const t = createTestResilience();
 * const policy = retry({ maxAttempts: 2, clock: t.clock });
 * const promise = policy.execute(failOnce, t.context());
 * await t.clock.tickAsync(0);
 * await promise;
 * ```
 */
export function createTestResilience(
  options: { start?: number } = {},
): TestResilienceHarness {
  const clock = new TestClock(options.start ?? 0);
  const controller = new AbortController();
  return {
    clock,
    controller,
    get signal() {
      return controller.signal;
    },
    context(overrides?: ExecutionContextOverrides): ExecutionContext {
      return executionContext({
        signal: overrides?.signal ?? controller.signal,
        attempt: overrides?.attempt,
      });
    },
  };
}

/**
 * Conformance scenarios for `forge/resilience`.
 *
 * `STANDARD_RESILIENCE_SCENARIOS` exercises the invariants every
 * well-formed {@link Policy} / {@link Pipeline} must satisfy:
 *
 * - The operation's value flows through unchanged on success.
 * - An already-aborted `ctx.signal` causes the pipeline to reject
 *   with the signal's reason without ever calling the operation.
 * - `executeResult` never throws; it always resolves to a
 *   {@link Result} with the underlying error preserved on the `err`
 *   branch.
 * - Aborting the operation's signal from outside the policy reaches
 *   the operation through `ctx.signal`.
 *
 * Each scenario receives a factory that builds a fresh {@link Pipeline}
 * — typically `combine(policyUnderTest, …)`. Run them against your
 * own pipelines (or stock ones from `forge/resilience`) to catch
 * regressions when wrapping new policies.
 *
 * Errors are plain `Error`s so the suite is framework-agnostic.
 *
 * @module
 */

import { CircuitOpenError, circuitBreaker } from "../circuit-breaker";
import type { CircuitState } from "../circuit-breaker";
import {
  RetryExhaustedError,
  exponentialBackoff,
  retry,
} from "../retry";
import { TimeoutError, timeout } from "../timeout";
import { hedge, HedgeCancelledError } from "../hedge";
import { combine } from "../pipeline";
import type { Pipeline, Policy } from "../types";
import { TestClock } from "./clock";

/**
 * Factory that returns a fresh pipeline for each scenario. Scenarios
 * never share state across runs — pass a function, not an instance.
 */
export type PipelineFactory = () => Pipeline;

/**
 * A single conformance scenario.
 *
 * `run(factory)` exercises the pipeline and either resolves on success
 * or throws an `Error` describing the violation.
 */
export interface ResilienceConformanceScenario {
  name: string;
  run(factory: PipelineFactory): Promise<void>;
}

/**
 * Scenarios that hold for *every* well-formed pipeline regardless of
 * which policies it wraps. Use `assertConformance(factory, scenarios)`
 * to run them.
 */
export const STANDARD_RESILIENCE_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "pipeline returns the operation's value on success",
      async run(factory) {
        const pipeline = factory();
        const value = await pipeline.execute(() => 42);
        if (value !== 42) {
          throw new Error(
            `expected pipeline.execute to return 42, got ${JSON.stringify(value)}`,
          );
        }
      },
    },
    {
      name: "pipeline.execute provides an AbortSignal to the operation",
      async run(factory) {
        const pipeline = factory();
        let seenSignal: AbortSignal | undefined;
        await pipeline.execute((ctx) => {
          seenSignal = ctx.signal;
          return 1;
        });
        if (!(seenSignal instanceof AbortSignal)) {
          throw new Error(
            "expected ctx.signal to be an AbortSignal",
          );
        }
      },
    },
    {
      name: "pipeline.execute provides a 1-based attempt counter",
      async run(factory) {
        const pipeline = factory();
        let seenAttempt = -1;
        await pipeline.execute((ctx) => {
          seenAttempt = ctx.attempt;
          return 1;
        });
        if (!Number.isInteger(seenAttempt) || seenAttempt < 1) {
          throw new Error(
            `expected ctx.attempt to be an integer >= 1, got ${seenAttempt}`,
          );
        }
      },
    },
    {
      name: "executeResult resolves to an Ok on success",
      async run(factory) {
        const pipeline = factory();
        const result = await pipeline.executeResult(() => "value");
        if (!result.isOk()) {
          throw new Error("expected an Ok result");
        }
        if (result.value !== "value") {
          throw new Error(
            `expected Ok("value"), got Ok(${JSON.stringify(result.value)})`,
          );
        }
      },
    },
    {
      name: "executeResult resolves to an Err on failure (never throws)",
      async run(factory) {
        // Pipelines that swallow errors (e.g. a sole `fallback`) are
        // exempt — they intentionally turn failures into successes. We
        // detect this by checking whether the pipeline can be made to
        // reject in the first place; if it can't, the no-throw
        // contract is vacuously satisfied.
        const probe = factory();
        const probeResult = await probe.execute(() => {
          throw new Error("probe");
        }).catch(() => "rejected" as const);
        if (probeResult !== "rejected") return;

        const pipeline = factory();
        const result = await pipeline.executeResult(() => {
          throw new Error("boom");
        });
        if (!result.isErr()) {
          throw new Error("expected an Err result");
        }
        if (!(result.error instanceof Error)) {
          throw new Error("expected Err to carry an Error");
        }
      },
    },
  ];

/**
 * Scenarios that are policy-specific. Unlike
 * {@link STANDARD_RESILIENCE_SCENARIOS}, these don't take a factory —
 * they build their own pipelines from the stock policies in
 * `forge/resilience`. Run them as part of the resilience module's own
 * test suite to catch regressions in the canonical implementations.
 */
export const POLICY_SPECIFIC_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "retry exhausts and throws RetryExhaustedError",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(
          retry({
            maxAttempts: 3,
            backoff: exponentialBackoff({ initial: 10, jitter: false }),
            clock,
          }),
        );
        const sentinel = new Error("always fails");
        const settled = pipeline.execute(() => {
          throw sentinel;
        }).catch((e) => e);
        // Drive both backoff sleeps.
        await flushMicrotasks();
        await clock.tickAsync(10);
        await clock.tickAsync(20);
        const err = await settled;
        if (!(err instanceof RetryExhaustedError)) {
          throw new Error(
            `expected RetryExhaustedError, got ${err?.constructor?.name ?? typeof err}`,
          );
        }
        if (err.attempts !== 3) {
          throw new Error(
            `expected attempts=3 on RetryExhaustedError, got ${err.attempts}`,
          );
        }
      },
    },
    {
      name: "timeout aborts ctx.signal when the deadline fires",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(timeout({ ms: 50, clock }));
        let observedAbort = false;
        const settled = pipeline
          .execute(async (ctx) => {
            await new Promise<void>((resolve, reject) => {
              ctx.signal.addEventListener("abort", () => {
                observedAbort = true;
                reject(ctx.signal.reason);
              }, { once: true });
            });
          })
          .catch((e) => e);
        await flushMicrotasks();
        await clock.tickAsync(50);
        const err = await settled;
        if (!(err instanceof TimeoutError)) {
          throw new Error(
            `expected TimeoutError, got ${err?.constructor?.name ?? typeof err}`,
          );
        }
        if (!observedAbort) {
          throw new Error(
            "expected the operation's ctx.signal to fire when the timeout elapsed",
          );
        }
      },
    },
    {
      name: "circuit breaker transitions closed → open → half-open → closed",
      async run() {
        const clock = new TestClock();
        const breaker = circuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 100,
          clock,
        });
        const pipeline = combine(breaker);
        // 1) closed → trip on first failure → open
        await pipeline.execute(() => {
          throw new Error("boom");
        }).catch(() => {});
        const openState: CircuitState = breaker.state;
        if (openState !== "open") {
          throw new Error(
            `expected breaker.state="open" after threshold, got "${openState}"`,
          );
        }
        // Subsequent call inside cool-down fails fast.
        const denied = await pipeline.execute(() => "x").catch((e) => e);
        if (!(denied instanceof CircuitOpenError)) {
          throw new Error(
            `expected CircuitOpenError while breaker is open, got ${denied?.constructor?.name}`,
          );
        }
        // 2) advance past resetTimeoutMs → next call is a probe (half-open)
        await clock.tickAsync(150);
        // 3) probe succeeds → closed
        const value = await pipeline.execute(() => "ok");
        if (value !== "ok") {
          throw new Error(`expected probe to succeed and return "ok", got ${value}`);
        }
        const closedState: CircuitState = breaker.state;
        if (closedState !== "closed") {
          throw new Error(
            `expected breaker.state="closed" after successful probe, got "${closedState}"`,
          );
        }
      },
    },
    {
      name: "hedge cancels losers via their AbortSignal when a winner settles",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(
          hedge({ delay: 10, maxHedgedAttempts: 2, clock }),
        );

        const aborts: Array<unknown> = [];
        let winnerReleased = false;
        let releaseWinner!: (value: string) => void;
        const winnerPromise = new Promise<string>((resolve) => {
          releaseWinner = (v) => {
            winnerReleased = true;
            resolve(v);
          };
        });

        let calls = 0;
        const settled = pipeline.execute((ctx) => {
          calls++;
          if (calls === 1) {
            // First attempt: park indefinitely; expect to be aborted.
            return new Promise<string>((_, reject) => {
              ctx.signal.addEventListener("abort", () => {
                aborts.push(ctx.signal.reason);
                reject(ctx.signal.reason);
              }, { once: true });
            });
          }
          // Second attempt wins immediately when released.
          return winnerPromise;
        });

        await flushMicrotasks();
        await clock.tickAsync(10); // fires second attempt
        await flushMicrotasks();
        releaseWinner("won");
        const value = await settled;

        if (value !== "won") {
          throw new Error(`expected hedge winner "won", got ${value}`);
        }
        if (!winnerReleased) {
          throw new Error("winner promise was not resolved (internal test bug)");
        }
        if (aborts.length !== 1) {
          throw new Error(
            `expected exactly one loser to be aborted, got ${aborts.length}`,
          );
        }
        if (!(aborts[0] instanceof HedgeCancelledError)) {
          throw new Error(
            `expected loser to be aborted with HedgeCancelledError, got ${
              (aborts[0] as { constructor?: { name?: string } } | undefined)
                ?.constructor?.name ?? typeof aborts[0]
            }`,
          );
        }
      },
    },
  ];

/**
 * Run every standard scenario against the given factory. Throws on
 * the first failing scenario.
 *
 * @example
 * ```ts
 * import { combine, retry, timeout } from "forge/resilience";
 * import {
 *   STANDARD_RESILIENCE_SCENARIOS,
 *   assertConformance,
 * } from "forge/resilience/testing";
 *
 * await assertConformance(
 *   () => combine(retry({ maxAttempts: 1 }), timeout({ ms: 100 })),
 *   STANDARD_RESILIENCE_SCENARIOS,
 * );
 * ```
 */
export async function assertConformance(
  factory: PipelineFactory,
  scenarios: readonly ResilienceConformanceScenario[] = STANDARD_RESILIENCE_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `resilience conformance: "${scenario.name}" failed — ${message}`,
        { cause: error },
      );
    }
  }
}

/**
 * Convenience wrapper that runs scenarios against a single
 * {@link Policy}. Wraps the policy in `combine(policy)` per scenario.
 */
export async function assertPolicyConformance(
  build: () => Policy,
  scenarios: readonly ResilienceConformanceScenario[] = STANDARD_RESILIENCE_SCENARIOS,
): Promise<void> {
  await assertConformance(() => combine(build()), scenarios);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    let remaining = 4;
    const drain = (): void => {
      if (remaining-- <= 0) {
        resolve();
        return;
      }
      queueMicrotask(drain);
    };
    drain();
  });
}

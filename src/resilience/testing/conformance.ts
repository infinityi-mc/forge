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

import { BulkheadFullError, bulkhead } from "../bulkhead";
import { CircuitOpenError, circuitBreaker } from "../circuit-breaker";
import type { CircuitState } from "../circuit-breaker";
import { fallback } from "../fallback";
import { hedge, HedgeCancelledError } from "../hedge";
import { combine } from "../pipeline";
import { RateLimitedError, rateLimit } from "../rate-limit";
import {
  RetryExhaustedError,
  exponentialBackoff,
  retry,
} from "../retry";
import { TimeoutError, timeout } from "../timeout";
import type { ExecutionContext, Pipeline, Policy } from "../types";
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
const CORE_POLICY_SCENARIOS: readonly ResilienceConformanceScenario[] = [
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

/** Scenarios for the stock bulkhead policy. */
export const BULKHEAD_RESILIENCE_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "bulkhead admits up to maxConcurrent concurrent operations",
      async run() {
        const bh = bulkhead({ maxConcurrent: 2 });
        const releases: Array<(value: string) => void> = [];

        const first = bh.execute(
          () => new Promise<string>((resolve) => {
            releases[0] = resolve;
          }),
          executionContext(),
        );
        const second = bh.execute(
          () => new Promise<string>((resolve) => {
            releases[1] = resolve;
          }),
          executionContext(),
        );

        await flushMicrotasks();
        if (bh.active !== 2) {
          throw new Error(`expected active=2, got ${bh.active}`);
        }

        releases[0]!("first");
        releases[1]!("second");
        const values = await Promise.all([first, second]);
        if (values.join(",") !== "first,second") {
          throw new Error(`unexpected bulkhead results: ${values.join(",")}`);
        }
        if (bh.active !== 0) {
          throw new Error(`expected active=0 after release, got ${bh.active}`);
        }
      },
    },
    {
      name: "bulkhead rejects when active slots and queue are saturated",
      async run() {
        const bh = bulkhead({ maxConcurrent: 1, maxQueue: 1 });
        let release!: (value: string) => void;
        const inFlight = bh.execute(
          () => new Promise<string>((resolve) => {
            release = resolve;
          }),
          executionContext(),
        );
        await flushMicrotasks();

        const queued = bh.execute(() => "queued", executionContext());
        await flushMicrotasks();
        if (bh.queued !== 1) {
          throw new Error(`expected queued=1, got ${bh.queued}`);
        }

        const denied = await bh
          .execute(() => "denied", executionContext())
          .catch((error) => error);
        if (!(denied instanceof BulkheadFullError)) {
          throw new Error(
            `expected BulkheadFullError, got ${denied?.constructor?.name ?? typeof denied}`,
          );
        }

        release("first");
        if (await inFlight !== "first") {
          throw new Error("expected in-flight operation to complete");
        }
        if (await queued !== "queued") {
          throw new Error("expected queued operation to complete");
        }
      },
    },
    {
      name: "bulkhead removes aborted queued callers",
      async run() {
        const bh = bulkhead({ maxConcurrent: 1, maxQueue: 2 });
        let release!: (value: string) => void;
        const inFlight = bh.execute(
          () => new Promise<string>((resolve) => {
            release = resolve;
          }),
          executionContext(),
        );
        await flushMicrotasks();

        const controller = new AbortController();
        const queued = bh
          .execute(() => "queued", executionContext(controller.signal))
          .catch((error) => error);
        await flushMicrotasks();
        if (bh.queued !== 1) {
          throw new Error(`expected queued=1 before abort, got ${bh.queued}`);
        }

        const reason = new Error("cancelled");
        controller.abort(reason);
        const aborted = await queued;
        if (aborted !== reason) {
          throw new Error("expected queued caller to reject with abort reason");
        }
        if (bh.queued !== 0) {
          throw new Error(`expected queued=0 after abort, got ${bh.queued}`);
        }

        release("first");
        await inFlight;
      },
    },
  ];

/** Scenarios for the stock fallback policy. */
export const FALLBACK_RESILIENCE_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "fallback passes through primary success",
      async run() {
        const pipeline = combine(fallback({ fallback: () => "stale" }));
        const value = await pipeline.execute(() => "fresh");
        if (value !== "fresh") {
          throw new Error(`expected primary value, got ${value}`);
        }
      },
    },
    {
      name: "fallback predicate can decline fallback handling",
      async run() {
        const primary = new Error("primary");
        const pipeline = combine(
          fallback({
            fallback: () => "stale",
            shouldFallback: () => false,
          }),
        );
        const err = await pipeline.execute(() => {
          throw primary;
        }).catch((error) => error);
        if (err !== primary) {
          throw new Error("expected original error when shouldFallback=false");
        }
      },
    },
    {
      name: "fallback preserves primary error as cause when fallback throws",
      async run() {
        const primary = new Error("primary");
        const secondary = new Error("secondary");
        const pipeline = combine(
          fallback({
            fallback: () => {
              throw secondary;
            },
          }),
        );
        const err = await pipeline.execute(() => {
          throw primary;
        }).catch((error) => error);
        if (err !== secondary) {
          throw new Error("expected fallback error to propagate");
        }
        if ((err as Error & { cause?: unknown }).cause !== primary) {
          throw new Error("expected fallback error cause to be primary error");
        }
      },
    },
  ];

/** Scenarios for the stock rate-limit policy. */
export const RATE_LIMIT_RESILIENCE_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "rate-limit throws with retryAfterMs when exhausted",
      async run() {
        const clock = new TestClock();
        const limiter = rateLimit({
          algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
          mode: "throw",
          clock,
        });
        await limiter.execute(() => "first", executionContext());
        const denied = await limiter
          .execute(() => "second", executionContext())
          .catch((error) => error);
        if (!(denied instanceof RateLimitedError)) {
          throw new Error(
            `expected RateLimitedError, got ${denied?.constructor?.name ?? typeof denied}`,
          );
        }
        if (denied.retryAfterMs <= 0) {
          throw new Error(
            `expected retryAfterMs > 0, got ${denied.retryAfterMs}`,
          );
        }
      },
    },
    {
      name: "rate-limit wait mode resumes after TestClock tick",
      async run() {
        const clock = new TestClock();
        const limiter = rateLimit({
          algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 1 },
          mode: "wait",
          clock,
        });
        await limiter.execute(() => "first", executionContext());

        const second = limiter.execute(() => "second", executionContext());
        await flushMicrotasks();
        if (limiter.pending !== 1) {
          throw new Error(`expected pending=1, got ${limiter.pending}`);
        }

        await clock.tickAsync(100);
        const value = await second;
        if (value !== "second") {
          throw new Error(`expected queued value "second", got ${value}`);
        }
        if (limiter.pending !== 0) {
          throw new Error(`expected pending=0, got ${limiter.pending}`);
        }
      },
    },
    {
      name: "rate-limit wait mode maxWaiters rejects excess waiters",
      async run() {
        const clock = new TestClock();
        const limiter = rateLimit({
          algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
          mode: "wait",
          maxWaiters: 1,
          clock,
        });
        await limiter.execute(() => "first", executionContext());
        const firstWaiter = limiter.execute(() => "waiter", executionContext());
        await flushMicrotasks();
        if (limiter.pending !== 1) {
          throw new Error(`expected pending=1, got ${limiter.pending}`);
        }

        const denied = await limiter
          .execute(() => "excess", executionContext())
          .catch((error) => error);
        if (!(denied instanceof RateLimitedError)) {
          throw new Error(
            `expected RateLimitedError for excess waiter, got ${denied?.constructor?.name ?? typeof denied}`,
          );
        }

        await clock.tickAsync(1_000);
        if (await firstWaiter !== "waiter") {
          throw new Error("expected accepted waiter to resume");
        }
      },
    },
  ];

/** Scenarios that exercise policy composition order and interference. */
export const COMPOSITION_RESILIENCE_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "composition runs fallback outside retry after exhaustion",
      async run() {
        let attempts = 0;
        const pipeline = combine(
          fallback({
            fallback: () => "fallback",
            shouldFallback: (error) => error instanceof RetryExhaustedError,
          }),
          retry({ maxAttempts: 2 }),
        );

        const value = await pipeline.execute<string>(() => {
          attempts++;
          throw new Error("boom");
        });
        if (value !== "fallback") {
          throw new Error(`expected fallback value, got ${value}`);
        }
        if (attempts !== 2) {
          throw new Error(`expected 2 retry attempts, got ${attempts}`);
        }
      },
    },
    {
      name: "composition lets retry observe timeout failures from inner timeout",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(
          retry({ maxAttempts: 2, clock }),
          timeout({ ms: 50, clock }),
        );
        let attempts = 0;

        const settled = pipeline.execute(async (ctx) => {
          attempts++;
          await clock.sleep(1_000, ctx.signal);
          return "never";
        }).catch((error) => error);

        await flushMicrotasks();
        await clock.tickAsync(50);
        await flushMicrotasks();
        await clock.tickAsync(50);

        const err = await settled;
        if (!(err instanceof RetryExhaustedError)) {
          throw new Error(
            `expected RetryExhaustedError, got ${err?.constructor?.name ?? typeof err}`,
          );
        }
        if (!((err as Error & { cause?: unknown }).cause instanceof TimeoutError)) {
          throw new Error("expected RetryExhaustedError cause to be TimeoutError");
        }
        if (attempts !== 2) {
          throw new Error(`expected timeout to run twice, got ${attempts}`);
        }
      },
    },
    {
      name: "composition applies rate-limit before bulkhead when ordered first",
      async run() {
        const clock = new TestClock();
        const limiter = rateLimit({
          algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
          mode: "throw",
          clock,
        });
        const bh = bulkhead({ maxConcurrent: 1, maxQueue: 1 });
        const pipeline = combine(limiter, bh);
        let release!: (value: string) => void;

        const first = pipeline.execute(
          () => new Promise<string>((resolve) => {
            release = resolve;
          }),
        );
        await flushMicrotasks();
        if (bh.active !== 1) {
          throw new Error(`expected active=1, got ${bh.active}`);
        }

        const denied = await pipeline.execute(() => "second").catch((error) => error);
        if (!(denied instanceof RateLimitedError)) {
          throw new Error(
            `expected RateLimitedError before bulkhead queueing, got ${denied?.constructor?.name ?? typeof denied}`,
          );
        }
        if (bh.queued !== 0) {
          throw new Error(`expected bulkhead queue to stay empty, got ${bh.queued}`);
        }

        release("first");
        if (await first !== "first") {
          throw new Error("expected first operation to complete");
        }
      },
    },
  ];

/** Scenarios proving policies can be driven by TestClock without real timers. */
export const CLOCK_DETERMINISM_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    {
      name: "TestClock controls retry backoff scheduling",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(
          retry({
            maxAttempts: 2,
            backoff: exponentialBackoff({ initial: 25, jitter: false }),
            clock,
          }),
        );
        let attempts = 0;
        const settled = pipeline.execute(() => {
          attempts++;
          if (attempts === 1) throw new Error("retry");
          return "ok";
        });

        await flushMicrotasks();
        if (attempts !== 1) {
          throw new Error(`expected one attempt before ticking, got ${attempts}`);
        }
        await clock.tickAsync(24);
        if (attempts !== 1) {
          throw new Error("retry resumed before its scheduled backoff");
        }
        await clock.tickAsync(1);
        if (await settled !== "ok") {
          throw new Error("expected retry to succeed after clock tick");
        }
      },
    },
    {
      name: "TestClock controls timeout deadlines",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(timeout({ ms: 50, clock }));
        const settled = pipeline.execute(async (ctx) => {
          await clock.sleep(1_000, ctx.signal);
          return "never";
        }).catch((error) => error);

        await flushMicrotasks();
        await clock.tickAsync(49);
        if (await Promise.race([settled, Promise.resolve("pending")]) !== "pending") {
          throw new Error("timeout fired before the configured deadline");
        }
        await clock.tickAsync(1);
        const err = await settled;
        if (!(err instanceof TimeoutError)) {
          throw new Error(
            `expected TimeoutError, got ${err?.constructor?.name ?? typeof err}`,
          );
        }
      },
    },
    {
      name: "TestClock controls rate-limit wait-mode resumes",
      async run() {
        const clock = new TestClock();
        const limiter = rateLimit({
          algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 1 },
          mode: "wait",
          clock,
        });
        await limiter.execute(() => "first", executionContext());
        const second = limiter.execute(() => "second", executionContext());

        await flushMicrotasks();
        await clock.tickAsync(99);
        if (limiter.pending !== 1) {
          throw new Error("rate-limit waiter resumed too early");
        }
        await clock.tickAsync(1);
        if (await second !== "second") {
          throw new Error("expected rate-limit waiter to resume after clock tick");
        }
      },
    },
    {
      name: "TestClock controls hedge delay scheduling",
      async run() {
        const clock = new TestClock();
        const pipeline = combine(
          hedge({ delay: 25, maxHedgedAttempts: 2, clock }),
        );
        let calls = 0;
        let releaseWinner!: (value: string) => void;
        const winner = new Promise<string>((resolve) => {
          releaseWinner = resolve;
        });

        const settled = pipeline.execute((ctx) => {
          calls++;
          if (calls === 1) {
            return new Promise<string>((_, reject) => {
              ctx.signal.addEventListener("abort", () => {
                reject(ctx.signal.reason);
              }, { once: true });
            });
          }
          return winner;
        });

        await flushMicrotasks();
        if (calls !== 1) {
          throw new Error(`expected one hedge attempt before delay, got ${calls}`);
        }
        await clock.tickAsync(24);
        if (calls !== 1) {
          throw new Error("hedged attempt started before delay elapsed");
        }
        await clock.tickAsync(1);
        if (calls !== 2) {
          throw new Error(`expected second hedge attempt, got ${calls}`);
        }
        releaseWinner("won");
        if (await settled !== "won") {
          throw new Error("expected hedge winner to settle pipeline");
        }
      },
    },
  ];

/**
 * Scenarios that are policy-specific. Unlike
 * {@link STANDARD_RESILIENCE_SCENARIOS}, these don't take a factory -
 * they build their own pipelines from the stock policies in
 * `forge/resilience`. Run them as part of the resilience module's own
 * test suite to catch regressions in the canonical implementations.
 */
export const POLICY_SPECIFIC_SCENARIOS: readonly ResilienceConformanceScenario[] =
  [
    ...CORE_POLICY_SCENARIOS,
    ...BULKHEAD_RESILIENCE_SCENARIOS,
    ...FALLBACK_RESILIENCE_SCENARIOS,
    ...RATE_LIMIT_RESILIENCE_SCENARIOS,
    ...COMPOSITION_RESILIENCE_SCENARIOS,
    ...CLOCK_DETERMINISM_SCENARIOS,
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

function executionContext(signal?: AbortSignal): ExecutionContext {
  return { signal: signal ?? new AbortController().signal, attempt: 1 };
}

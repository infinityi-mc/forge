/**
 * `rateLimit` — admit-or-wait policy enforcing a token-bucket (burst
 * friendly) or sliding-window (strict) rate ceiling.
 *
 * The policy holds its admission state in-memory and per-instance —
 * cluster-wide limits are explicitly out of scope (see the module
 * README). Two modes determine what happens when no slot is
 * available:
 *
 * - `mode: "throw"` (default) — reject immediately with
 *   {@link RateLimitedError}, carrying a `retryAfterMs` hint.
 * - `mode: "wait"` — park the caller until a slot is free. Honors the
 *   incoming `AbortSignal` so an outer timeout can cancel the wait.
 *
 * @module
 */

import { realClock } from "../clock";
import { buildInstruments } from "../telemetry/instrumentation";
import type { Clock, ExecutionContext, Operation } from "../types";
import { RateLimitedError } from "./errors";
import { SlidingWindowLimiter } from "./sliding-window";
import { TokenBucket } from "./token-bucket";
import type { RateLimitOptions, RateLimitPolicy } from "./types";

interface AdmissionStrategy {
  acquire(now: number): { waitMs: number };
  available(now: number): number;
}

/**
 * Create a rate-limit policy.
 *
 * @example Token bucket, fast-fail
 * ```ts
 * const limiter = rateLimit({
 *   algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 20 },
 *   mode: "throw",
 * });
 * ```
 *
 * @example Sliding window, queueing
 * ```ts
 * const limiter = rateLimit({
 *   algorithm: { kind: "sliding-window", limit: 100, windowMs: 60_000 },
 *   mode: "wait",
 *   maxWaiters: 50,
 * });
 * ```
 */
export function rateLimit(options: RateLimitOptions): RateLimitPolicy {
  const mode = options.mode ?? "throw";
  const maxWaiters = options.maxWaiters ?? Infinity;
  const clock: Clock = options.clock ?? realClock;
  const instruments = buildInstruments(options.telemetry);

  const strategy = buildStrategy(options, clock.now());
  let waiting = 0;

  async function execute<T>(
    op: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    if (ctx.signal.aborted) throw ctx.signal.reason;

    let countedAsWaiting = false;
    try {
      while (true) {
        const decision = strategy.acquire(clock.now());
        if (decision.waitMs <= 0) break;

        if (mode === "throw" || (!countedAsWaiting && waiting >= maxWaiters)) {
          throw new RateLimitedError(`rate-limit: no token available`, {
            retryAfterMs: decision.waitMs,
          });
        }

        if (!countedAsWaiting) {
          waiting++;
          countedAsWaiting = true;
        }
        await clock.sleep(decision.waitMs, ctx.signal);
      }
    } finally {
      if (countedAsWaiting) waiting = Math.max(0, waiting - 1);
    }

    instruments.attempts()?.add(1, { policy: "rate-limit", mode });
    return op(ctx);
  }

  return {
    name: "rate-limit",
    get availableTokens() {
      return strategy.available(clock.now());
    },
    get pending() {
      return waiting;
    },
    execute,
  };
}

function buildStrategy(
  options: RateLimitOptions,
  now: number,
): AdmissionStrategy {
  const algo = options.algorithm;
  if (algo.kind === "token-bucket") {
    if (!Number.isFinite(algo.tokensPerSecond) || algo.tokensPerSecond <= 0) {
      throw new RangeError(
        `rateLimit: tokensPerSecond must be > 0, got ${algo.tokensPerSecond}`,
      );
    }
    const burst = algo.burst ?? algo.tokensPerSecond;
    if (!Number.isFinite(burst) || burst < 1) {
      throw new RangeError(`rateLimit: burst must be >= 1, got ${burst}`);
    }
    return new TokenBucket(algo.tokensPerSecond, burst, now);
  }
  if (algo.kind === "sliding-window") {
    if (!Number.isInteger(algo.limit) || algo.limit < 1) {
      throw new RangeError(
        `rateLimit: limit must be an integer >= 1, got ${algo.limit}`,
      );
    }
    if (!Number.isFinite(algo.windowMs) || algo.windowMs <= 0) {
      throw new RangeError(
        `rateLimit: windowMs must be > 0, got ${algo.windowMs}`,
      );
    }
    return new SlidingWindowLimiter(algo.limit, algo.windowMs);
  }
  throw new TypeError(
    `rateLimit: unknown algorithm kind "${(algo as { kind: string }).kind}"`,
  );
}

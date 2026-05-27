import { describe, expect, test } from "bun:test";
import {
  RateLimitedError,
  combine,
  rateLimit,
} from "../../../src/resilience";
import { TestClock, executionContext } from "../../../src/resilience/testing";

describe("rateLimit (token-bucket)", () => {
  test("admits up to burst immediately", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 3 },
      mode: "throw",
      clock,
    });

    expect(await limiter.execute(() => 1, executionContext())).toBe(1);
    expect(await limiter.execute(() => 2, executionContext())).toBe(2);
    expect(await limiter.execute(() => 3, executionContext())).toBe(3);

    const denied = await limiter
      .execute(() => 4, executionContext())
      .catch((e) => e);
    expect(denied).toBeInstanceOf(RateLimitedError);
    expect((denied as RateLimitedError).retryAfterMs).toBeGreaterThan(0);
  });

  test("refills based on elapsed clock time", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 1 },
      mode: "throw",
      clock,
    });

    // Burn the burst.
    expect(await limiter.execute(() => "a", executionContext())).toBe("a");
    const denied = await limiter
      .execute(() => "b", executionContext())
      .catch((e) => e);
    expect(denied).toBeInstanceOf(RateLimitedError);

    // One refill window later, a token is available again.
    await clock.tickAsync(100);
    expect(await limiter.execute(() => "b", executionContext())).toBe("b");
  });

  test("wait mode queues until a token is available", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 10, burst: 1 },
      mode: "wait",
      clock,
    });

    expect(await limiter.execute(() => "first", executionContext())).toBe(
      "first",
    );
    expect(limiter.pending).toBe(0);

    const second = limiter.execute(() => "second", executionContext());
    // Yield so the policy registers as pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.pending).toBe(1);

    await clock.tickAsync(100);
    expect(await second).toBe("second");
    expect(limiter.pending).toBe(0);
  });

  test("wait mode respects abort signal during the wait", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
      mode: "wait",
      clock,
    });

    await limiter.execute(() => 1, executionContext());

    const controller = new AbortController();
    const ctx = executionContext({ signal: controller.signal });
    const blocked = limiter.execute(() => 2, ctx).catch((e) => e);
    await Promise.resolve();
    await Promise.resolve();

    const reason = new Error("aborted");
    controller.abort(reason);
    expect(await blocked).toBe(reason);
  });

  test("wait mode caps queue at maxWaiters", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
      mode: "wait",
      maxWaiters: 1,
      clock,
    });

    await limiter.execute(() => 1, executionContext());

    // First waiter — accepted (queues).
    const first = limiter.execute(() => 2, executionContext());
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.pending).toBe(1);

    // Second waiter — over the cap, rejected immediately.
    const denied = await limiter
      .execute(() => 3, executionContext())
      .catch((e) => e);
    expect(denied).toBeInstanceOf(RateLimitedError);

    await clock.tickAsync(1_000);
    expect(await first).toBe(2);
  });
});

describe("rateLimit (sliding-window)", () => {
  test("rejects beyond limit until window slides", async () => {
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "sliding-window", limit: 2, windowMs: 100 },
      mode: "throw",
      clock,
    });

    expect(await limiter.execute(() => 1, executionContext())).toBe(1);
    expect(await limiter.execute(() => 2, executionContext())).toBe(2);

    const denied = await limiter
      .execute(() => 3, executionContext())
      .catch((e) => e);
    expect(denied).toBeInstanceOf(RateLimitedError);

    // After the window slides, slots free up.
    await clock.tickAsync(101);
    expect(await limiter.execute(() => 4, executionContext())).toBe(4);
  });
});

describe("rateLimit pipeline integration", () => {
  test("pipeline propagates RateLimitedError", async () => {
    const clock = new TestClock();
    const pipeline = combine(
      rateLimit({
        algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
        mode: "throw",
        clock,
      }),
    );
    expect(await pipeline.execute(() => "a")).toBe("a");
    const err = await pipeline.execute(() => "b").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
  });

  test("validates algorithm options", () => {
    expect(() =>
      rateLimit({
        algorithm: { kind: "token-bucket", tokensPerSecond: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      rateLimit({
        algorithm: { kind: "sliding-window", limit: 0, windowMs: 100 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      rateLimit({
        algorithm: { kind: "sliding-window", limit: 1, windowMs: 0 },
      }),
    ).toThrow(RangeError);
  });
});

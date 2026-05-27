import { describe, expect, test } from "bun:test";
import {
  CircuitOpenError,
  circuitBreaker,
  combine,
} from "../../../src/resilience";
import { TestClock, executionContext } from "../../../src/resilience/testing";

describe("circuitBreaker", () => {
  test("starts closed and forwards calls", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1_000,
    });
    expect(breaker.state).toBe("closed");

    const result = await breaker.execute(() => 42, executionContext());
    expect(result).toBe(42);
    expect(breaker.state).toBe("closed");
  });

  test("trips to open after failureThreshold consecutive failures", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1_000,
      window: { kind: "count", size: 10 },
    });

    for (let i = 0; i < 3; i++) {
      const err = await breaker
        .execute(() => {
          throw new Error("boom");
        }, executionContext())
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
    }
    expect(breaker.state).toBe("open");

    // Subsequent calls fast-fail without invoking the operation.
    let called = 0;
    const open = await breaker
      .execute(() => {
        called++;
        return "x";
      }, executionContext())
      .catch((e) => e);
    expect(open).toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(0);
  });

  test("ratio threshold requires minimumRequests samples", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 0.5,
      minimumRequests: 4,
      resetTimeoutMs: 1_000,
      window: { kind: "count", size: 10 },
    });

    // 2 failures over 2 samples → 100% but below minimumRequests=4.
    for (let i = 0; i < 2; i++) {
      await breaker
        .execute(() => {
          throw new Error("f");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("closed");

    // 2 more failures → 4 samples, 100% failure ratio → open.
    for (let i = 0; i < 2; i++) {
      await breaker
        .execute(() => {
          throw new Error("f");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("open");
  });

  test("transitions to half-open after resetTimeoutMs", async () => {
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("boom");
      }, executionContext())
      .catch(() => {});
    expect(breaker.state).toBe("open");

    // Before cool-down: still open.
    await clock.tickAsync(50);
    const stillOpen = await breaker
      .execute(() => "ok", executionContext())
      .catch((e) => e);
    expect(stillOpen).toBeInstanceOf(CircuitOpenError);

    // After cool-down: first call transitions to half-open and runs.
    await clock.tickAsync(60);
    const result = await breaker.execute(() => "recovered", executionContext());
    expect(result).toBe("recovered");
    expect(breaker.state).toBe("closed");
  });

  test("half-open failure reopens the breaker", async () => {
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("initial");
      }, executionContext())
      .catch(() => {});
    expect(breaker.state).toBe("open");

    await clock.tickAsync(50);

    const failed = await breaker
      .execute(() => {
        throw new Error("still broken");
      }, executionContext())
      .catch((e) => e);
    expect((failed as Error).message).toBe("still broken");
    expect(breaker.state).toBe("open");
  });

  test("half-open caps concurrent probes at halfOpenMaxAttempts", async () => {
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("boom");
      }, executionContext())
      .catch(() => {});
    await clock.tickAsync(50);

    // First call transitions to half-open and is in-flight.
    let resolve!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      resolve = r;
    });
    const inFlight = breaker.execute(() => slow, executionContext());
    expect(breaker.state).toBe("half-open");

    // Second concurrent call rejected — no probe slots left.
    const rejected = await breaker
      .execute(() => "x", executionContext())
      .catch((e) => e);
    expect(rejected).toBeInstanceOf(CircuitOpenError);

    resolve("ok");
    expect(await inFlight).toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  test("forceOpen / forceClosed override window state", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 1_000,
    });

    breaker.forceOpen();
    expect(breaker.state).toBe("open");
    const rejected = await breaker
      .execute(() => 1, executionContext())
      .catch((e) => e);
    expect(rejected).toBeInstanceOf(CircuitOpenError);

    breaker.forceClosed();
    expect(breaker.state).toBe("closed");
    expect(await breaker.execute(() => 7, executionContext())).toBe(7);
  });

  test("shouldTrip filters non-trip errors as successes", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1_000,
      shouldTrip: (err) =>
        err instanceof Error && err.message !== "user-error",
    });

    // Two user errors — should NOT trip.
    for (let i = 0; i < 2; i++) {
      await breaker
        .execute(() => {
          throw new Error("user-error");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("closed");

    // Two upstream errors — should trip.
    for (let i = 0; i < 2; i++) {
      await breaker
        .execute(() => {
          throw new Error("upstream");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("open");
  });

  test("integrates with combine() pipeline", async () => {
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });
    const pipeline = combine(breaker);

    await pipeline
      .execute(async () => {
        throw new Error("fail");
      })
      .catch(() => {});
    expect(breaker.state).toBe("open");

    const err = await pipeline.execute(async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });
});

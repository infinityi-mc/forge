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

  test("half-open non-trip-error clears window before closing (fixes premature re-tripping)", async () => {
    // Bug scenario: with failureThreshold: 3 and CountWindow(10):
    // 1. Three failures trip breaker → open with [F, F, F]
    // 2. After resetTimeoutMs, probe in half-open throws non-trip error
    // 3. Without window.clear(), [F, F, F] + success → [F, F, F, S]
    // 4. Back in closed, ONE new failure → [F, F, F, S, F] with 4 failures
    // 5. 4 >= 3 → breaker trips immediately
    // Fix: ensure window.clear() happens before transition("closed") in
    // the non-trip-error path.

    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 50,
      window: { kind: "count", size: 10 },
      shouldTrip: (err) =>
        err instanceof Error && err.message !== "non-trip-error",
      clock,
    });

    // Step 1: Trip the breaker with three failures.
    for (let i = 0; i < 3; i++) {
      await breaker
        .execute(() => {
          throw new Error("trip");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("open");

    // Step 2: Transition to half-open and probe with a non-trip error.
    await clock.tickAsync(50);
    await breaker
      .execute(() => {
        throw new Error("non-trip-error");
      }, executionContext())
      .catch(() => {});
    expect(breaker.state).toBe("closed");

    // Step 3: Record ONE new failure.
    await breaker
      .execute(() => {
        throw new Error("trip");
      }, executionContext())
      .catch(() => {});

    // Step 4: Breaker should NOT trip from a single failure.
    // If the window was not cleared, we'd have [F, F, F, S, F] and
    // trip immediately. Since it was cleared, we have [F] and stay closed.
    expect(breaker.state).toBe("closed");

    // Two more failures should trip it.
    for (let i = 0; i < 2; i++) {
      await breaker
        .execute(() => {
          throw new Error("trip");
        }, executionContext())
        .catch(() => {});
    }
    expect(breaker.state).toBe("open");
  });

  test("forceOpen refreshes cooldown when breaker is already open", async () => {
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 30_000,
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("trip");
      }, executionContext())
      .catch(() => {});
    expect(breaker.state).toBe("open");

    // Operator extends the incident-response open window near the end
    // of the original cool-down.
    await clock.tickAsync(25_000);
    breaker.forceOpen();

    // At the original retry time (T=30s), it must still be open.
    await clock.tickAsync(5_000);
    const stillOpen = await breaker
      .execute(() => "probe-too-early", executionContext())
      .catch((e) => e);
    expect(stillOpen).toBeInstanceOf(CircuitOpenError);
    expect(breaker.state).toBe("open");

    // Only after a full resetTimeoutMs from the manual forceOpen call
    // should the breaker allow a half-open probe.
    await clock.tickAsync(25_000);
    const recovered = await breaker.execute(() => "recovered", executionContext());
    expect(recovered).toBe("recovered");
    expect(breaker.state).toBe("closed");
  });

});

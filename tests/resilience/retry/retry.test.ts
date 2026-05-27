import { describe, expect, test } from "bun:test";
import {
  combine,
  exponentialBackoff,
  retry,
  RetryExhaustedError,
  TransientError,
} from "../../../src/resilience";
import { executionContext, TestClock } from "../../../src/resilience/testing";

describe("retry policy", () => {
  test("returns immediately on success", async () => {
    const clock = new TestClock();
    const policy = retry({ maxAttempts: 3, clock });
    const result = await policy.execute(() => 42, executionContext());
    expect(result).toBe(42);
  });

  test("retries until the operation succeeds", async () => {
    let attempts = 0;
    const policy = retry({ maxAttempts: 3 });
    const result = await policy.execute(() => {
      attempts++;
      if (attempts < 3) throw new Error(`fail ${attempts}`);
      return "ok";
    }, executionContext());
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("throws RetryExhaustedError when maxAttempts is reached", async () => {
    let attempts = 0;
    const policy = retry({ maxAttempts: 3 });
    const err = await policy.execute(() => {
      attempts++;
      throw new Error("always");
    }, executionContext()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect((err as RetryExhaustedError).attempts).toBe(3);
    expect((err as { cause?: Error }).cause).toBeInstanceOf(Error);
    expect((err as { cause?: Error }).cause!.message).toBe("always");
    expect(attempts).toBe(3);
  });

  test("rejects maxAttempts < 1", () => {
    expect(() => retry({ maxAttempts: 0 })).toThrow(RangeError);
    expect(() => retry({ maxAttempts: 1.5 })).toThrow(RangeError);
  });

  test("respects shouldRetry predicate — false short-circuits", async () => {
    let attempts = 0;
    const policy = retry({
      maxAttempts: 5,
      shouldRetry: (err) => err instanceof TransientError,
    });
    const err = await policy.execute(() => {
      attempts++;
      throw new Error("permanent");
    }, executionContext()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("permanent");
    expect(attempts).toBe(1);
  });

  test("increments attempt number in the execution context", async () => {
    const attemptsSeen: number[] = [];
    const policy = retry({ maxAttempts: 3 });
    await policy.execute((ctx) => {
      attemptsSeen.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error("retry");
      return "ok";
    }, executionContext());
    expect(attemptsSeen).toEqual([1, 2, 3]);
  });

  test("retryOn treats matching values as failures", async () => {
    let attempts = 0;
    const policy = retry({
      maxAttempts: 3,
      retryOn: (value) => value === "transient",
    });
    const result = await policy.execute(() => {
      attempts++;
      return attempts < 3 ? "transient" : "good";
    }, executionContext());
    expect(result).toBe("good");
    expect(attempts).toBe(3);
  });

  test("waits for backoff between attempts (TestClock)", async () => {
    const clock = new TestClock();
    let attempts = 0;
    const policy = retry({
      maxAttempts: 3,
      backoff: exponentialBackoff({ initial: 100, factor: 2, jitter: false }),
      clock,
    });

    const settled: { value?: string; err?: unknown } = {};
    const promise = policy
      .execute(() => {
        attempts++;
        if (attempts < 3) throw new Error(`fail ${attempts}`);
        return "ok";
      }, executionContext())
      .then(
        (value) => {
          settled.value = value;
        },
        (err) => {
          settled.err = err;
        },
      );

    // Let attempt 1 run synchronously to its failure.
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(clock.pendingCount).toBe(1);

    // First backoff: 100ms.
    await clock.tickAsync(100);
    expect(attempts).toBe(2);
    expect(clock.pendingCount).toBe(1);

    // Second backoff: 200ms.
    await clock.tickAsync(200);
    expect(attempts).toBe(3);

    await promise;
    expect(settled.value).toBe("ok");
  });

  test("aborts immediately when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    const policy = retry({ maxAttempts: 3 });
    const err = await policy
      .execute(() => 1, executionContext({ signal: controller.signal }))
      .then(
        () => null,
        (e) => e,
      );
    expect((err as Error).message).toBe("user cancel");
  });

  test("default backoff is constant 0 — retries immediately", async () => {
    let attempts = 0;
    const start = Date.now();
    const policy = retry({ maxAttempts: 3 });
    await policy.execute(() => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
      return "ok";
    }, executionContext());
    // Should complete almost instantly; allow generous slack for CI.
    expect(Date.now() - start).toBeLessThan(50);
    expect(attempts).toBe(3);
  });

  test("composes inside a pipeline", async () => {
    let attempts = 0;
    const pipeline = combine(retry({ maxAttempts: 4 }));
    const result = await pipeline.execute(() => {
      attempts++;
      if (attempts < 2) throw new TransientError("not yet");
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(2);
  });
});

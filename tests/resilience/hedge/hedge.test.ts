import { describe, expect, test } from "bun:test";
import { HedgeCancelledError, combine, hedge } from "../../../src/resilience";
import { TestClock, executionContext } from "../../../src/resilience/testing";

describe("hedge", () => {
  test("returns the value of the first attempt when it resolves before the delay", async () => {
    const clock = new TestClock();
    let calls = 0;
    const policy = hedge({ delay: 100, maxHedgedAttempts: 3, clock });
    const value = await policy.execute(() => {
      calls++;
      return "fast";
    }, executionContext());
    expect(value).toBe("fast");
    expect(calls).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  test("fires a second attempt after the delay and the winner cancels the loser", async () => {
    const clock = new TestClock();
    const losers: unknown[] = [];
    let winnerSignal: AbortSignal | undefined;
    let call = 0;
    const winnerSentinel = Symbol("ok");

    const promise = hedge({ delay: 10, maxHedgedAttempts: 2, clock }).execute(
      (ctx) => {
        call++;
        if (call === 1) {
          // First attempt parks until aborted.
          return new Promise((_, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                losers.push(ctx.signal.reason);
                reject(ctx.signal.reason);
              },
              { once: true },
            );
          });
        }
        // Second attempt wins immediately.
        winnerSignal = ctx.signal;
        return winnerSentinel;
      },
      executionContext(),
    );

    // Microtasks: first attempt is launched + the scheduler awaits sleep.
    await Promise.resolve();
    await Promise.resolve();
    // Tick past the hedge delay to fire the second attempt.
    await clock.tickAsync(10);
    const value = await promise;
    expect(value).toBe(winnerSentinel);
    expect(call).toBe(2);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toBeInstanceOf(HedgeCancelledError);
    expect(winnerSignal?.aborted).toBe(false);
  });

  test("rejects with the last error when every attempt fails", async () => {
    const clock = new TestClock();
    const errors = [new Error("e1"), new Error("e2"), new Error("e3")];
    let i = 0;
    const promise = hedge({
      delay: 5,
      maxHedgedAttempts: 3,
      clock,
    })
      .execute(() => {
        throw errors[i++];
      }, executionContext())
      .catch((e) => e);

    // Each attempt rejects synchronously. The first goes immediately;
    // the scheduler keeps launching the others after each sleep tick.
    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(5);
    await clock.tickAsync(5);
    const err = await promise;
    expect(errors).toContain(err);
    expect(i).toBe(3);
  });

  test("returns the winning value even when sibling fails first", async () => {
    const clock = new TestClock();
    let releaseSecond!: (v: string) => void;
    const secondPromise = new Promise<string>((resolve) => {
      releaseSecond = resolve;
    });
    let call = 0;
    const promise = hedge({ delay: 5, maxHedgedAttempts: 2, clock }).execute(
      () => {
        call++;
        if (call === 1) throw new Error("first failed");
        return secondPromise;
      },
      executionContext(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(5);
    releaseSecond("won");
    expect(await promise).toBe("won");
  });

  test("aborts every in-flight attempt when the parent signal aborts", async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const ctx = executionContext({ signal: controller.signal });
    const losers: unknown[] = [];

    const promise = hedge({ delay: 10, maxHedgedAttempts: 3, clock })
      .execute((inner) => {
        return new Promise((_, reject) => {
          inner.signal.addEventListener(
            "abort",
            () => {
              losers.push(inner.signal.reason);
              reject(inner.signal.reason);
            },
            { once: true },
          );
        });
      }, ctx)
      .catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(10);
    await Promise.resolve();

    const reason = new Error("parent aborted");
    controller.abort(reason);
    const result = await promise;
    expect(result).toBe(reason);
    // Every launched attempt's child signal should have fired with the
    // parent reason, not HedgeCancelledError.
    for (const loser of losers) expect(loser).toBe(reason);
    expect(losers.length).toBeGreaterThanOrEqual(2);
  });

  test("passthrough behavior when maxHedgedAttempts is 1", async () => {
    const policy = hedge({ delay: 50, maxHedgedAttempts: 1 });
    let calls = 0;
    const value = await policy.execute(() => {
      calls++;
      return "single";
    }, executionContext());
    expect(value).toBe("single");
    expect(calls).toBe(1);
  });

  test("fails fast if the parent context is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("upstream");
    controller.abort(reason);
    const result = await hedge({ delay: 10, maxHedgedAttempts: 2 })
      .execute(() => "x", executionContext({ signal: controller.signal }))
      .catch((e) => e);
    expect(result).toBe(reason);
  });

  test("validates option ranges", () => {
    expect(() => hedge({ delay: -1, maxHedgedAttempts: 2 })).toThrow(
      RangeError,
    );
    expect(() => hedge({ delay: 10, maxHedgedAttempts: 0 })).toThrow(
      RangeError,
    );
    expect(() => hedge({ delay: 10, maxHedgedAttempts: 1.5 })).toThrow(
      RangeError,
    );
  });

  test("cancels pending hedge timers when a later attempt wins", async () => {
    const clock = new TestClock();
    let call = 0;
    const promise = hedge({ delay: 10, maxHedgedAttempts: 3, clock }).execute(
      (ctx) => {
        call++;
        if (call === 1) {
          return new Promise((_, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => reject(ctx.signal.reason),
              {
                once: true,
              },
            );
          });
        }
        return "won";
      },
      executionContext(),
    );

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(10);

    expect(await promise).toBe("won");
    expect(call).toBe(2);
    expect(clock.pendingCount).toBe(0);
  });

  test("integrates with combine() pipeline", async () => {
    const clock = new TestClock();
    const pipeline = combine(hedge({ delay: 10, maxHedgedAttempts: 2, clock }));
    const value = await pipeline.execute(() => "fast");
    expect(value).toBe("fast");
  });
});

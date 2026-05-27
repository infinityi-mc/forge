import { describe, expect, test } from "bun:test";
import {
  combine,
  retry,
  timeout,
  TimeoutError,
} from "../../../src/resilience";
import { executionContext, TestClock } from "../../../src/resilience/testing";

describe("timeout policy", () => {
  test("returns the operation's value when it completes before the deadline", async () => {
    const clock = new TestClock();
    const policy = timeout({ ms: 1_000, clock });
    const result = await policy.execute(() => "fast", executionContext());
    expect(result).toBe("fast");
  });

  test("throws TimeoutError when the deadline elapses (optimistic, TestClock)", async () => {
    const clock = new TestClock();
    const policy = timeout({ ms: 100, clock });

    let signalSeenAborted = false;
    const settled: { value?: unknown; err?: unknown } = {};
    const promise = policy
      .execute(async (ctx) => {
        // Wait longer than the deadline. The TestClock drives both
        // sleeps so we observe the abort on the operation's signal.
        await clock.sleep(10_000, ctx.signal).catch((reason) => {
          signalSeenAborted = ctx.signal.aborted;
          throw reason;
        });
        return "never";
      }, executionContext())
      .then(
        (value) => {
          settled.value = value;
        },
        (err) => {
          settled.err = err;
        },
      );

    // Let the operation start and register its sleep.
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pendingCount).toBe(2); // operation sleep + timer sleep

    // Advance to the deadline — timer wins.
    await clock.tickAsync(100);
    await promise;

    expect(settled.err).toBeInstanceOf(TimeoutError);
    expect((settled.err as TimeoutError).timeoutMs).toBe(100);
    expect((settled.err as TimeoutError).strategy).toBe("optimistic");
    expect(signalSeenAborted).toBe(true);
  });

  test("aborts the inner AbortSignal so cooperating I/O is cancelled", async () => {
    const clock = new TestClock();
    const policy = timeout({ ms: 50, clock });

    let abortReason: unknown;
    const promise = policy
      .execute(async (ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              abortReason = ctx.signal.reason;
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
        return "never";
      }, executionContext())
      .catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(50);
    const result = await promise;

    expect(result).toBeInstanceOf(TimeoutError);
    expect(abortReason).toBeInstanceOf(TimeoutError);
  });

  test("pessimistic strategy waits for the operation to settle before throwing", async () => {
    const clock = new TestClock();
    const policy = timeout({ ms: 50, strategy: "pessimistic", clock });

    let opCompletedAt: number | undefined;
    const promise = policy
      .execute(async (ctx) => {
        try {
          await clock.sleep(200, ctx.signal);
          return "never";
        } catch (reason) {
          // After the abort observation, do "cleanup" — modeled here
          // as another 100ms of work. With pessimistic, the policy
          // must wait until *this* settles before throwing.
          await clock.sleep(100);
          opCompletedAt = clock.now();
          throw reason;
        }
      }, executionContext())
      .catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();

    // Trigger the timeout.
    await clock.tickAsync(50);
    // Optimistic would have rejected here. Pessimistic waits for
    // the cleanup sleep too.
    expect(opCompletedAt).toBeUndefined();

    await clock.tickAsync(100);
    const result = await promise;
    expect(result).toBeInstanceOf(TimeoutError);
    expect(opCompletedAt).toBe(150);
  });

  test("does not abort when the operation completes first", async () => {
    const clock = new TestClock();
    const policy = timeout({ ms: 100, clock });

    let abortObserved = false;
    const result = await policy.execute((ctx) => {
      ctx.signal.addEventListener("abort", () => {
        abortObserved = true;
      });
      return "quick";
    }, executionContext());

    expect(result).toBe("quick");
    // Give the timer's cancellation listener a microtask to run.
    await clock.tickAsync(0);
    expect(abortObserved).toBe(false);
  });

  test("propagates an already-aborted parent signal immediately", async () => {
    const policy = timeout({ ms: 1_000 });
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    const err = await policy
      .execute(() => "never", executionContext({ signal: controller.signal }))
      .catch((e) => e);
    expect((err as Error).message).toBe("user cancel");
  });

  test("rejects negative deadlines", () => {
    expect(() => timeout({ ms: -1 })).toThrow(RangeError);
    expect(() => timeout({ ms: Number.NaN })).toThrow(RangeError);
  });

  test("retry sees TimeoutError as a retryable failure", async () => {
    const clock = new TestClock();
    let attempts = 0;
    const pipeline = combine(
      retry({ maxAttempts: 3, clock }),
      timeout({ ms: 50, clock }),
    );

    const promise = pipeline
      .execute(async (ctx) => {
        attempts++;
        if (attempts < 3) {
          await clock.sleep(500, ctx.signal);
          return "never";
        }
        return "ok";
      })
      .catch((e) => e);

    // Drive each attempt's timer.
    for (let i = 0; i < 2; i++) {
      await Promise.resolve();
      await Promise.resolve();
      await clock.tickAsync(50);
    }
    const result = await promise;
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("real clock — short deadline aborts a real fetch-like wait", async () => {
    // Sanity-check the real-clock path; keep the deadline tiny so
    // the test stays fast.
    const policy = timeout({ ms: 20 });
    const err = await policy
      .execute(
        () =>
          new Promise((_resolve, reject) => {
            // Caller doesn't observe abort — pessimistic-but-default
            // optimistic should still throw on the deadline. We
            // reject manually after a long delay to ensure the
            // outer race resolves via the timer.
            setTimeout(() => reject(new Error("never")), 5_000);
          }),
        executionContext(),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });
});

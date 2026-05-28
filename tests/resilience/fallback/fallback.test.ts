import { describe, expect, test } from "bun:test";
import {
  ResilienceError,
  RetryExhaustedError,
  combine,
  fallback,
  retry,
} from "../../../src/resilience";
import { executionContext } from "../../../src/resilience/testing";

describe("fallback", () => {
  test("passes through the primary value on success", async () => {
    const policy = fallback({ fallback: () => "stale" });
    const value = await policy.execute(() => "fresh", executionContext());
    expect(value).toBe("fresh");
  });

  test("invokes the fallback when the primary throws", async () => {
    const policy = fallback({ fallback: () => "stale" });
    const value = await policy.execute<string>(() => {
      throw new Error("boom");
    }, executionContext());
    expect(value).toBe("stale");
  });

  test("passes the original error and the same ctx to the handler", async () => {
    const primary = new Error("boom");
    let seenError: unknown;
    let seenSignal: AbortSignal | undefined;
    const ctx = executionContext();
    const policy = fallback({
      fallback: (err, ctx) => {
        seenError = err;
        seenSignal = ctx.signal;
        return "stale";
      },
    });
    await policy.execute(() => {
      throw primary;
    }, ctx);
    expect(seenError).toBe(primary);
    expect(seenSignal).toBe(ctx.signal);
  });

  test("re-throws when shouldFallback returns false", async () => {
    const policy = fallback({
      fallback: () => "stale",
      shouldFallback: () => false,
    });
    const err = await policy
      .execute(() => {
        throw new Error("auth");
      }, executionContext())
      .catch((e) => e);
    expect((err as Error).message).toBe("auth");
  });

  test("preserves the primary error on cause when fallback itself throws", async () => {
    const primary = new Error("primary");
    const secondary = new Error("secondary");
    const policy = fallback({
      fallback: () => {
        throw secondary;
      },
    });
    const err = await policy
      .execute(() => {
        throw primary;
      }, executionContext())
      .catch((e) => e);
    expect(err).toBe(secondary);
    expect((err as Error & { cause?: unknown }).cause).toBe(primary);
  });

  test("does not overwrite an existing cause on the fallback's error", async () => {
    const primary = new Error("primary");
    const innerCause = new Error("pre-existing cause");
    const policy = fallback({
      fallback: () => {
        const err = new Error("secondary");
        (err as { cause?: unknown }).cause = innerCause;
        throw err;
      },
    });
    const err = await policy
      .execute(() => {
        throw primary;
      }, executionContext())
      .catch((e) => e);
    expect((err as Error & { cause?: unknown }).cause).toBe(innerCause);
  });

  test("integrates with combine() outside retry — gates on retry exhaustion", async () => {
    let attempts = 0;
    const pipeline = combine(
      fallback({
        fallback: () => "fallback",
        shouldFallback: (err) => err instanceof ResilienceError,
      }),
      retry({ maxAttempts: 2 }),
    );
    const value = await pipeline.execute<string>(() => {
      attempts++;
      throw new Error("boom");
    });
    expect(value).toBe("fallback");
    expect(attempts).toBe(2);
  });

  test("predicate sees the RetryExhaustedError (not the underlying)", async () => {
    let seen: unknown;
    const pipeline = combine(
      fallback({
        fallback: () => "ok",
        shouldFallback: (err) => {
          seen = err;
          return true;
        },
      }),
      retry({ maxAttempts: 2 }),
    );
    await pipeline.execute(() => {
      throw new Error("boom");
    });
    expect(seen).toBeInstanceOf(RetryExhaustedError);
  });

  test("supports async fallback handlers", async () => {
    const policy = fallback({
      fallback: async () => {
        await Promise.resolve();
        return "stale-async";
      },
    });
    const value = await policy.execute<string>(() => {
      throw new Error("boom");
    }, executionContext());
    expect(value).toBe("stale-async");
  });
});

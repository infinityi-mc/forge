import { describe, expect, test } from "bun:test";
import {
  combine,
  ResilienceError,
  retry,
  TransientError,
  isErr,
  isOk,
  type ExecutionContext,
} from "../../src/resilience";

describe("combine / pipeline", () => {
  test("identity pipeline runs the operation against a fresh context", async () => {
    const pipeline = combine();
    const seen: ExecutionContext[] = [];
    const result = await pipeline.execute((ctx) => {
      seen.push(ctx);
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attempt).toBe(1);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal.aborted).toBe(false);
  });

  test("supports synchronous operations", async () => {
    const pipeline = combine();
    expect(await pipeline.execute(() => "sync")).toBe("sync");
  });

  test("propagates errors thrown by the operation", async () => {
    const pipeline = combine();
    await expect(
      pipeline.execute(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("composes policies outermost-first", async () => {
    const order: string[] = [];
    const tracePolicy = (label: string) => ({
      name: label,
      async execute<T>(
        next: (ctx: ExecutionContext) => Promise<T> | T,
        ctx: ExecutionContext,
      ): Promise<T> {
        order.push(`enter:${label}`);
        try {
          return await next(ctx);
        } finally {
          order.push(`exit:${label}`);
        }
      },
    });

    const pipeline = combine(tracePolicy("outer"), tracePolicy("inner"));
    await pipeline.execute(() => {
      order.push("op");
      return "ok";
    });

    expect(order).toEqual([
      "enter:outer",
      "enter:inner",
      "op",
      "exit:inner",
      "exit:outer",
    ]);
  });

  test("executeResult returns Ok on success", async () => {
    const pipeline = combine();
    const result = await pipeline.executeResult(() => 5);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(5);
  });

  test("executeResult wraps ResilienceError on failure", async () => {
    const pipeline = combine(
      retry({ maxAttempts: 2, backoff: { delay: () => 0 } }),
    );
    const result = await pipeline.executeResult(() => {
      throw new TransientError("nope");
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ResilienceError);
    }
  });

  test("executeResult wraps non-ResilienceError throws", async () => {
    const pipeline = combine();
    const result = await pipeline.executeResult(() => {
      throw new Error("user-thrown");
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ResilienceError);
      expect((result.error as Error).message).toBe("operation failed");
      expect((result.error as { cause?: Error }).cause).toBeInstanceOf(Error);
    }
  });

  test("result helpers", async () => {
    const pipeline = combine();
    const okResult = await pipeline.executeResult(() => "x");
    expect(okResult.ok).toBe(true);
    expect(okResult.isOk()).toBe(true);
    expect(okResult.isErr()).toBe(false);

    const errResult = await pipeline.executeResult(() => {
      throw new Error("bad");
    });
    expect(errResult.ok).toBe(false);
    expect(errResult.isOk()).toBe(false);
    expect(errResult.isErr()).toBe(true);
  });
});

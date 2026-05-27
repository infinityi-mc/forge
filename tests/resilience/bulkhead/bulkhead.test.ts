import { describe, expect, test } from "bun:test";
import {
  BulkheadFullError,
  bulkhead,
  combine,
} from "../../../src/resilience";
import { executionContext } from "../../../src/resilience/testing";

describe("bulkhead", () => {
  test("admits up to maxConcurrent calls in parallel", async () => {
    const bh = bulkhead({ maxConcurrent: 2 });

    const gates: Array<(v: string) => void> = [];
    const slow = (i: number) =>
      new Promise<string>((r) => {
        gates[i] = r;
      });

    const a = bh.execute(() => slow(0), executionContext());
    const b = bh.execute(() => slow(1), executionContext());

    // Both calls are now in flight.
    await Promise.resolve();
    expect(bh.active).toBe(2);

    gates[0]!("a");
    gates[1]!("b");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(bh.active).toBe(0);
  });

  test("rejects with BulkheadFullError when queue is full", async () => {
    const bh = bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      release = r;
    });

    const inFlight = bh.execute(() => slow, executionContext());
    await Promise.resolve();
    expect(bh.active).toBe(1);

    // Queue slot 1 — accepted (parked).
    const queued = bh.execute(() => "queued", executionContext());
    await Promise.resolve();
    await Promise.resolve();
    expect(bh.queued).toBe(1);

    // Queue slot 2 — rejected.
    const denied = await bh
      .execute(() => "denied", executionContext())
      .catch((e) => e);
    expect(denied).toBeInstanceOf(BulkheadFullError);
    expect((denied as BulkheadFullError).active).toBe(1);
    expect((denied as BulkheadFullError).queued).toBe(1);

    release("first");
    expect(await inFlight).toBe("first");
    expect(await queued).toBe("queued");
    expect(bh.active).toBe(0);
    expect(bh.queued).toBe(0);
  });

  test("queued caller resumes when a slot frees", async () => {
    const bh = bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    const releases: Array<(v: string) => void> = [];
    const slow = (i: number) =>
      new Promise<string>((r) => {
        releases[i] = r;
      });

    const a = bh.execute(() => slow(0), executionContext());
    const b = bh.execute(() => slow(1), executionContext());
    const c = bh.execute(() => slow(2), executionContext());
    await Promise.resolve();
    await Promise.resolve();

    expect(bh.active).toBe(1);
    expect(bh.queued).toBe(2);

    releases[0]!("a");
    expect(await a).toBe("a");
    await Promise.resolve();
    expect(bh.active).toBe(1);
    expect(bh.queued).toBe(1);

    releases[1]!("b");
    expect(await b).toBe("b");
    await Promise.resolve();

    releases[2]!("c");
    expect(await c).toBe("c");
    expect(bh.active).toBe(0);
    expect(bh.queued).toBe(0);
  });

  test("queued caller is released when its abort signal fires", async () => {
    const bh = bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      release = r;
    });
    const inFlight = bh.execute(() => slow, executionContext());
    await Promise.resolve();

    const controller = new AbortController();
    const ctx = executionContext({ signal: controller.signal });
    const queued = bh.execute(() => "queued", ctx).catch((e) => e);
    await Promise.resolve();
    expect(bh.queued).toBe(1);

    const reason = new Error("user cancelled");
    controller.abort(reason);
    expect(await queued).toBe(reason);
    expect(bh.queued).toBe(0);

    release("first");
    expect(await inFlight).toBe("first");
  });

  test("releases slot even when operation throws", async () => {
    const bh = bulkhead({ maxConcurrent: 1 });
    const err = await bh
      .execute(() => {
        throw new Error("boom");
      }, executionContext())
      .catch((e) => e);
    expect((err as Error).message).toBe("boom");
    expect(bh.active).toBe(0);

    // Slot should be free for the next caller.
    expect(await bh.execute(() => "ok", executionContext())).toBe("ok");
  });

  test("fails fast when ctx is already aborted", async () => {
    const bh = bulkhead({ maxConcurrent: 1 });
    const controller = new AbortController();
    const reason = new Error("aborted upstream");
    controller.abort(reason);
    const ctx = executionContext({ signal: controller.signal });

    const result = await bh.execute(() => "x", ctx).catch((e) => e);
    expect(result).toBe(reason);
    expect(bh.active).toBe(0);
  });

  test("integrates with combine() pipeline", async () => {
    const bh = bulkhead({ maxConcurrent: 1, maxQueue: 0 });
    const pipeline = combine(bh);

    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      release = r;
    });
    const first = pipeline.execute(() => slow);
    await Promise.resolve();

    const denied = await pipeline.execute(() => "second").catch((e) => e);
    expect(denied).toBeInstanceOf(BulkheadFullError);

    release("first");
    expect(await first).toBe("first");
  });

  test("validates options at construction time", () => {
    expect(() => bulkhead({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() =>
      bulkhead({ maxConcurrent: 1, maxQueue: -1 }),
    ).toThrow(RangeError);
  });
});

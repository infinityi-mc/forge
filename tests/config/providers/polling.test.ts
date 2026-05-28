import { describe, expect, test } from "bun:test";
import { pollingProvider } from "../../../src/config/providers/polling";
import type { DynamicConfigSnapshot } from "../../../src/config/providers/types";

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("pollingProvider", () => {
  test("rejects non-positive / non-finite intervals at construction time", () => {
    expect(() =>
      pollingProvider({
        name: "p",
        intervalMs: 0,
        fetch: async () => ({}),
      }),
    ).toThrow(RangeError);
    expect(() =>
      pollingProvider({
        name: "p",
        intervalMs: -10,
        fetch: async () => ({}),
      }),
    ).toThrow(RangeError);
    expect(() =>
      pollingProvider({
        name: "p",
        intervalMs: Number.NaN,
        fetch: async () => ({}),
      }),
    ).toThrow(RangeError);
  });

  test("get() calls fetch immediately and returns its result", async () => {
    let calls = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 60_000,
      fetch: async () => {
        calls += 1;
        return { a: "1" };
      },
    });
    expect(await provider.get()).toEqual({ a: "1" });
    expect(calls).toBe(1);
  });

  test("subscribe() drives the polling loop and fires the handler on each fetch", async () => {
    const snapshots: DynamicConfigSnapshot[] = [
      { x: "1" },
      { x: "2" },
      { x: "3" },
    ];
    let idx = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      fetch: async () => {
        return snapshots[idx++] ?? { x: "done" };
      },
    });
    const received: DynamicConfigSnapshot[] = [];
    const unsub = provider.subscribe((s) => received.push(s));

    // Wait for ~3 ticks. 5ms interval × 3 = 15ms; pad to 80ms so we
    // never race on a slow runner.
    await new Promise((r) => setTimeout(r, 80));
    unsub();
    await provider.shutdown!();

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0]).toEqual({ x: "1" });
    // The list is consumed in arrival order.
    expect(received.map((s) => s["x"])).toEqual(
      [...received.keys()].map((i) => snapshots[i]?.x ?? "done"),
    );
  });

  test("multiple subscribers each see every snapshot", async () => {
    let n = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      fetch: async () => ({ n: String(n++) }),
    });
    const a: DynamicConfigSnapshot[] = [];
    const b: DynamicConfigSnapshot[] = [];
    provider.subscribe((s) => a.push(s));
    provider.subscribe((s) => b.push(s));

    await new Promise((r) => setTimeout(r, 60));
    await provider.shutdown!();

    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  test("a thrown handler does not crash the loop or stop sibling handlers", async () => {
    const captured: unknown[] = [];
    let goodCalls = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      fetch: async () => ({ x: "1" }),
      onError: (err) => captured.push(err),
    });
    provider.subscribe(() => {
      throw new Error("boom");
    });
    provider.subscribe(() => {
      goodCalls += 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    await provider.shutdown!();

    // The thrown handler did not stop the sibling handler from
    // running on the same tick.
    expect(goodCalls).toBeGreaterThan(0);
    // And the throw was routed to onError, not swallowed.
    expect(captured.length).toBeGreaterThan(0);
    expect((captured[0] as Error).message).toBe("boom");
  });

  test("a thrown fetch is routed to onError; the loop keeps polling", async () => {
    let attempts = 0;
    const captured: unknown[] = [];
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { x: String(attempts) };
      },
      onError: (err) => captured.push(err),
    });
    const seen: DynamicConfigSnapshot[] = [];
    provider.subscribe((s) => seen.push(s));

    await new Promise((r) => setTimeout(r, 60));
    await provider.shutdown!();

    expect(captured.length).toBe(1);
    expect((captured[0] as Error).message).toBe("transient");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("shutdown() stops further fetches and unblocks future subscriptions", async () => {
    let calls = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      fetch: async () => {
        calls += 1;
        return { x: "1" };
      },
    });
    provider.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await provider.shutdown!();
    const callsAtShutdown = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(callsAtShutdown);
  });

  test("external AbortSignal stops the loop as soon as it aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = pollingProvider({
      name: "p",
      intervalMs: 5,
      signal: controller.signal,
      fetch: async () => {
        calls += 1;
        return { x: "1" };
      },
    });
    provider.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    const callsOnAbort = calls;
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBeLessThanOrEqual(callsOnAbort + 1);
  });
});

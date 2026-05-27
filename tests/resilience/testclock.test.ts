import { describe, expect, test } from "bun:test";
import { TestClock } from "../../src/resilience/testing";

describe("TestClock", () => {
  test("now() advances by tickAsync", async () => {
    const clock = new TestClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.tickAsync(250);
    expect(clock.now()).toBe(1_250);
  });

  test("sleep(0) resolves on the next microtask", async () => {
    const clock = new TestClock();
    let done = false;
    clock.sleep(0).then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  test("sleep does not resolve before its deadline", async () => {
    const clock = new TestClock();
    let resolved = false;
    void clock.sleep(100).then(() => {
      resolved = true;
    });

    await clock.tickAsync(50);
    expect(resolved).toBe(false);

    await clock.tickAsync(50);
    expect(resolved).toBe(true);
  });

  test("multiple sleeps fire in order at their deadlines", async () => {
    const clock = new TestClock();
    const order: string[] = [];
    void clock.sleep(100).then(() => order.push("a"));
    void clock.sleep(50).then(() => order.push("b"));
    void clock.sleep(200).then(() => order.push("c"));

    await clock.tickAsync(50);
    expect(order).toEqual(["b"]);
    await clock.tickAsync(50);
    expect(order).toEqual(["b", "a"]);
    await clock.tickAsync(100);
    expect(order).toEqual(["b", "a", "c"]);
  });

  test("sleep rejects with the signal's reason when aborted before deadline", async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const reason = new Error("cancel");
    const promise = clock.sleep(1_000, controller.signal);
    controller.abort(reason);
    const err = await promise.catch((e) => e);
    expect(err).toBe(reason);
    expect(clock.pendingCount).toBe(0);
  });

  test("sleep rejects synchronously if the signal is already aborted", async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    const err = await clock.sleep(100, controller.signal).catch((e) => e);
    expect(err).toBe(reason);
    expect(clock.pendingCount).toBe(0);
  });

  test("rejects negative ticks", async () => {
    const clock = new TestClock();
    await expect(clock.tickAsync(-1)).rejects.toThrow(RangeError);
  });

  test("pendingCount reflects active sleeps", async () => {
    const clock = new TestClock();
    expect(clock.pendingCount).toBe(0);
    void clock.sleep(50);
    void clock.sleep(50);
    expect(clock.pendingCount).toBe(2);
    await clock.tickAsync(50);
    expect(clock.pendingCount).toBe(0);
  });
});

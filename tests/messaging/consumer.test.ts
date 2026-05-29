import { describe, expect, test } from "bun:test";
import { createConsumer, createMessageBus } from "../../src/messaging";
import type { Message } from "../../src/messaging";
import { inMemoryTransport } from "../../src/messaging/transports/memory";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createConsumer", () => {
  test("redelivers with an incremented attempt after a handler throws", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const attempts: number[] = [];
    const consumer = createConsumer({
      transport,
      topic: "retry.me",
      handler: (msg) => {
        attempts.push(msg.attempt);
        if (attempts.length === 1) throw new Error("boom");
      },
    });
    await consumer.start();

    await bus.publish({ type: "retry.me", payload: {} });
    await waitFor(() => attempts.length >= 2);
    await consumer.stop();

    expect(attempts[0]).toBe(0);
    expect(attempts[1]).toBe(1);
  });

  test("does not redeliver after a successful handler", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let count = 0;
    const consumer = createConsumer({
      transport,
      topic: "once",
      handler: () => {
        count += 1;
      },
    });
    await consumer.start();

    await bus.publish({ type: "once", payload: {} });
    await waitFor(() => count === 1);
    // Give any erroneous redelivery a chance to occur.
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    expect(count).toBe(1);
  });

  test("processes messages concurrently up to the configured limit", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let inFlight = 0;
    let maxInFlight = 0;
    const done: Message[] = [];
    const consumer = createConsumer({
      transport,
      topic: "work",
      concurrency: 3,
      handler: async (msg) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        done.push(msg);
      },
    });
    await consumer.start();

    await bus.publishBatch(
      Array.from({ length: 9 }, (_, i) => ({ type: "work", payload: i })),
    );
    await waitFor(() => done.length === 9, 3_000);
    await consumer.stop();

    expect(done.length).toBe(9);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("aborts the consume context signal on stop", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let signal: AbortSignal | undefined;
    const consumer = createConsumer({
      transport,
      topic: "sig",
      handler: (_msg, ctx) => {
        signal = ctx.signal;
      },
    });
    await consumer.start();
    await bus.publish({ type: "sig", payload: {} });
    await waitFor(() => signal !== undefined);
    expect(signal!.aborted).toBe(false);
    await consumer.stop();
    expect(signal!.aborted).toBe(true);
  });

  test("start is idempotent", async () => {
    const transport = inMemoryTransport();
    const consumer = createConsumer({
      transport,
      topic: "x",
      handler: () => {},
    });
    await consumer.start();
    await consumer.start();
    await consumer.stop();
  });
});

import { describe, expect, test } from "bun:test";
import { createConsumer, createMessageBus } from "../../src/messaging";
import type { Message, Transport, TransportRecord } from "../../src/messaging";
import { TransportError } from "../../src/messaging/errors";
import { inMemoryTransport } from "../../src/messaging/transports/memory";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createMessageBus", () => {
  test("publishes a message a consumer receives with envelope fields populated", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const received: Message[] = [];
    const consumer = createConsumer({
      transport,
      topic: "order.placed",
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();

    const before = Date.now();
    await bus.publish({ type: "order.placed", payload: { orderId: "1" } });
    await waitFor(() => received.length === 1);
    await consumer.stop();

    const msg = received[0]!;
    expect(msg.type).toBe("order.placed");
    expect(msg.payload).toEqual({ orderId: "1" });
    expect(typeof msg.id).toBe("string");
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.attempt).toBe(0);
    expect(msg.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("uses an explicit id and merges default headers under per-message headers", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({
      transport,
      defaultHeaders: { "x-app": "orders", "x-env": "test" },
    });
    let seen: Message | undefined;
    const consumer = createConsumer({
      transport,
      topic: "evt",
      handler: (m) => {
        seen = m;
      },
    });
    await consumer.start();

    await bus.publish({
      type: "evt",
      payload: {},
      id: "fixed-id",
      headers: { "x-env": "override", "x-extra": "1" },
    });
    await waitFor(() => seen !== undefined);
    await consumer.stop();

    expect(seen!.id).toBe("fixed-id");
    expect(seen!.headers).toEqual({
      "x-app": "orders",
      "x-env": "override",
      "x-extra": "1",
    });
    // The reserved occurredAt header is not exposed to the handler.
    expect("x-forge-occurred-at" in seen!.headers).toBe(false);
  });

  test("publishBatch sends every message", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const received: Message[] = [];
    const consumer = createConsumer({
      transport,
      topic: "*",
      handler: (m) => {
        received.push(m);
      },
    });
    await consumer.start();

    await bus.publishBatch([
      { type: "a", payload: 1 },
      { type: "b", payload: 2 },
      { type: "c", payload: 3 },
    ]);
    await waitFor(() => received.length === 3);
    await consumer.stop();

    expect(received.map((m) => m.type).sort()).toEqual(["a", "b", "c"]);
  });

  test("wraps transport send failures in TransportError", async () => {
    const failing: Transport = {
      name: "failing",
      async send(_records: readonly TransportRecord[]): Promise<void> {
        throw new Error("broker down");
      },
      async subscribe() {
        return { async stop() {} };
      },
    };
    const bus = createMessageBus({ transport: failing });
    await expect(
      bus.publish({ type: "x", payload: {} }),
    ).rejects.toThrow(TransportError);
  });

  test("shutdown delegates to the transport", async () => {
    let shutdown = false;
    const transport: Transport = {
      name: "t",
      async send() {},
      async subscribe() {
        return { async stop() {} };
      },
      async shutdown() {
        shutdown = true;
      },
    };
    const bus = createMessageBus({ transport });
    await bus.shutdown();
    expect(shutdown).toBe(true);
  });
});

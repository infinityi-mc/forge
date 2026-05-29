import { describe, expect, test } from "bun:test";
import { createConsumer, createMessageBus } from "../../src/messaging";
import type { Message } from "../../src/messaging";
import { inMemoryTransport } from "../../src/messaging/transports/memory";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("publish → consume integration", () => {
  test("a published message is delivered to a consumer on the matching topic", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const received: Message[] = [];

    const consumer = createConsumer({
      transport,
      topic: "user.created",
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();

    await bus.publish({
      type: "user.created",
      payload: { userId: "u-42", email: "alice@example.com" },
    });

    await waitFor(() => received.length === 1);
    await consumer.stop();

    const msg = received[0]!;
    expect(msg.type).toBe("user.created");
    expect(msg.payload).toEqual({ userId: "u-42", email: "alice@example.com" });
    expect(typeof msg.id).toBe("string");
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.attempt).toBe(0);
    expect(msg.occurredAt).toBeInstanceOf(Date);
  });

  test("consumer does not receive messages for a different topic", async () => {
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

    await bus.publish({ type: "invoice.sent", payload: { invoiceId: "inv-1" } });

    // Allow time for any erroneous delivery.
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    expect(received).toHaveLength(0);
  });

  test("multiple messages are all delivered and processed in order of receipt", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const payloads: number[] = [];

    const consumer = createConsumer({
      transport,
      topic: "counter.incremented",
      handler: (msg) => {
        payloads.push(msg.payload as number);
      },
    });
    await consumer.start();

    for (let i = 1; i <= 5; i++) {
      await bus.publish({ type: "counter.incremented", payload: i });
    }

    await waitFor(() => payloads.length === 5);
    await consumer.stop();

    expect(payloads).toEqual([1, 2, 3, 4, 5]);
  });

  test("published headers are forwarded to the consumer", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({
      transport,
      defaultHeaders: { "x-tenant": "acme" },
    });
    let received: Message | undefined;

    const consumer = createConsumer({
      transport,
      topic: "evt",
      handler: (msg) => {
        received = msg;
      },
    });
    await consumer.start();

    await bus.publish({
      type: "evt",
      payload: null,
      headers: { "x-request-id": "req-99" },
    });

    await waitFor(() => received !== undefined);
    await consumer.stop();

    expect(received!.headers["x-tenant"]).toBe("acme");
    expect(received!.headers["x-request-id"]).toBe("req-99");
  });

  test("wildcard consumer receives messages from any topic", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const types: string[] = [];

    const consumer = createConsumer({
      transport,
      topic: "*",
      handler: (msg) => {
        types.push(msg.type);
      },
    });
    await consumer.start();

    await bus.publish({ type: "a.happened", payload: {} });
    await bus.publish({ type: "b.happened", payload: {} });

    await waitFor(() => types.length === 2);
    await consumer.stop();

    expect(types).toContain("a.happened");
    expect(types).toContain("b.happened");
  });

  test("multiple consumers on the same topic each receive the message", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const consumerA: Message[] = [];
    const consumerB: Message[] = [];

    const a = createConsumer({
      transport,
      topic: "shared.topic",
      handler: (msg) => {
        consumerA.push(msg);
      },
    });
    const b = createConsumer({
      transport,
      topic: "shared.topic",
      handler: (msg) => {
        consumerB.push(msg);
      },
    });
    await a.start();
    await b.start();

    await bus.publish({ type: "shared.topic", payload: { v: 1 } });

    await waitFor(() => consumerA.length === 1 && consumerB.length === 1);
    await a.stop();
    await b.stop();

    expect(consumerA[0]!.payload).toEqual({ v: 1 });
    expect(consumerB[0]!.payload).toEqual({ v: 1 });
  });

  test("explicit message id is preserved through publish and consume", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let received: Message | undefined;

    const consumer = createConsumer({
      transport,
      topic: "id.check",
      handler: (msg) => {
        received = msg;
      },
    });
    await consumer.start();

    await bus.publish({
      type: "id.check",
      payload: "hello",
      id: "my-stable-id",
    });

    await waitFor(() => received !== undefined);
    await consumer.stop();

    expect(received!.id).toBe("my-stable-id");
  });

  test("publishBatch delivers all messages to the consumer", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const received: Message[] = [];

    const consumer = createConsumer({
      transport,
      topic: "batch.item",
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();

    await bus.publishBatch([
      { type: "batch.item", payload: "first" },
      { type: "batch.item", payload: "second" },
      { type: "batch.item", payload: "third" },
    ]);

    await waitFor(() => received.length === 3);
    await consumer.stop();

    const payloads = received.map((m) => m.payload).sort();
    expect(payloads).toEqual(["first", "second", "third"]);
  });

  test("consumer handler receives a non-aborted signal in the context", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let signalAborted: boolean | undefined;

    const consumer = createConsumer({
      transport,
      topic: "ctx.signal",
      handler: (_msg, ctx) => {
        signalAborted = ctx.signal.aborted;
      },
    });
    await consumer.start();

    await bus.publish({ type: "ctx.signal", payload: {} });
    await waitFor(() => signalAborted !== undefined);
    await consumer.stop();

    expect(signalAborted).toBe(false);
  });

  test("occurredAt is a valid Date close to publish time", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let received: Message | undefined;

    const consumer = createConsumer({
      transport,
      topic: "time.check",
      handler: (msg) => {
        received = msg;
      },
    });
    await consumer.start();

    const before = Date.now();
    await bus.publish({ type: "time.check", payload: {} });
    await waitFor(() => received !== undefined);
    const after = Date.now();
    await consumer.stop();

    expect(received!.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(received!.occurredAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  test("shutdown cleans up bus and consumer without errors", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const received: Message[] = [];

    const consumer = createConsumer({
      transport,
      topic: "cleanup",
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();

    await bus.publish({ type: "cleanup", payload: "done" });
    await waitFor(() => received.length === 1);

    await consumer.stop();
    await bus.shutdown();

    expect(received[0]!.payload).toBe("done");
  });
});

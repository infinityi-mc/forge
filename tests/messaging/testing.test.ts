import { describe, expect, test } from "bun:test";
import {
  InMemoryMessageBus,
  STANDARD_MESSAGING_SCENARIOS,
  assertConformance,
  createTestMessaging,
} from "../../src/messaging/testing";
import { inMemoryTransport } from "../../src/messaging/transports/memory";
import type { Message } from "../../src/messaging";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("InMemoryMessageBus", () => {
  test("records publishes in the README { type, payload } shape", async () => {
    const bus = new InMemoryMessageBus();
    await bus.publish({ type: "OrderPlaced", payload: { orderId: "123" } });
    expect(bus.publishedEvents).toContainEqual({
      type: "OrderPlaced",
      payload: { orderId: "123" },
    });
  });

  test("exposes full envelopes and supports clear()", async () => {
    const bus = new InMemoryMessageBus();
    await bus.publish({ type: "a", payload: 1, id: "id-a" });
    await bus.publishBatch([{ type: "b", payload: 2 }]);
    expect(bus.messages.length).toBe(2);
    expect(bus.messages[0]!.id).toBe("id-a");
    bus.clear();
    expect(bus.messages.length).toBe(0);
    expect(bus.publishedEvents.length).toBe(0);
  });

  test("forwards to a transport when one is provided", async () => {
    const transport = inMemoryTransport();
    const bus = new InMemoryMessageBus({ transport });
    const received: Message[] = [];
    const handle = await transport.subscribe({
      topic: "*",
      onMessage: (d) => {
        received.push({
          id: d.record.id,
          type: d.record.type,
          payload: JSON.parse(new TextDecoder().decode(d.record.body)),
          headers: {},
          occurredAt: new Date(),
          attempt: d.attempt,
        });
        d.ack();
      },
    });

    await bus.publish({ type: "fwd", payload: { ok: true } });
    await waitFor(() => received.length === 1);
    await handle.stop();

    expect(received[0]!.type).toBe("fwd");
    expect(bus.publishedEvents).toContainEqual({
      type: "fwd",
      payload: { ok: true },
    });
  });
});

describe("createTestMessaging", () => {
  test("wires a recording bus to a shared transport with a consumer factory", async () => {
    const t = createTestMessaging();
    const received: Message[] = [];
    const consumer = t.consumer("greeting", (msg) => {
      received.push(msg);
    });
    await consumer.start();

    await t.bus.publish({ type: "greeting", payload: "hi" });
    await waitFor(() => received.length === 1);
    await consumer.stop();

    expect(received[0]!.payload).toBe("hi");
    expect(t.bus.publishedEvents).toContainEqual({ type: "greeting", payload: "hi" });
  });
});

describe("conformance", () => {
  test("inMemoryTransport satisfies STANDARD_MESSAGING_SCENARIOS", async () => {
    await assertConformance(() => inMemoryTransport());
  });

  test("ships at least the round-trip, headers, and redelivery scenarios", () => {
    expect(STANDARD_MESSAGING_SCENARIOS.length).toBeGreaterThanOrEqual(3);
  });
});

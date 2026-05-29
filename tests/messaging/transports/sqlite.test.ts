import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  STANDARD_MESSAGING_SCENARIOS,
  assertConformance,
} from "../../../src/messaging/testing";
import { createMessageBus } from "../../../src/messaging";
import { createConsumer } from "../../../src/messaging";
import { sqliteTransport } from "../../../src/messaging/transports/sqlite";
import type { Message } from "../../../src/messaging";

describe("sqliteTransport conformance", () => {
  test("satisfies the standard messaging scenarios", async () => {
    await assertConformance(
      () => sqliteTransport({ pollIntervalMs: 5 }),
      STANDARD_MESSAGING_SCENARIOS,
    );
  });

  // Spell out each scenario as its own test for granular reporting.
  for (const scenario of STANDARD_MESSAGING_SCENARIOS) {
    test(scenario.name, async () => {
      await scenario.run(() => sqliteTransport({ pollIntervalMs: 5 }));
    });
  }
});

describe("sqliteTransport durability", () => {
  test("a published record survives a transport restart", async () => {
    const db = new Database(":memory:", { create: true });

    // Producer publishes through one transport instance, then it "crashes".
    const producer = sqliteTransport({ database: db, pollIntervalMs: 5 });
    const bus = createMessageBus({ transport: producer });
    await bus.publish({ type: "durable.event", payload: { n: 1 }, id: "d1" });
    await producer.shutdown();

    // A fresh transport over the same database still delivers it.
    const consumerTransport = sqliteTransport({ database: db, pollIntervalMs: 5 });
    const received: Message[] = [];
    const consumer = createConsumer({
      transport: consumerTransport,
      topic: "durable.event",
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();
    const deadline = Date.now() + 1000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await consumer.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("d1");
    expect(received[0]?.payload).toEqual({ n: 1 });

    await consumerTransport.shutdown();
  });

  test("an always-nacked record is dropped after maxDeliveries", async () => {
    const transport = sqliteTransport({ maxDeliveries: 3, pollIntervalMs: 5 });
    const bus = createMessageBus({ transport });
    let attempts = 0;
    const consumer = createConsumer({
      transport,
      topic: "poison.event",
      handler: () => {
        attempts += 1;
        throw new Error("always fails");
      },
    });
    await consumer.start();
    await bus.publish({ type: "poison.event", payload: {}, id: "p1" });

    const deadline = Date.now() + 1000;
    while (attempts < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Give the queue a moment to settle (it should be empty / not redelivered).
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    expect(attempts).toBe(3);
    await transport.shutdown();
  });

  test("rejects an unsafe table name", () => {
    expect(() => sqliteTransport({ table: "messages; drop table x" })).toThrow();
  });
});

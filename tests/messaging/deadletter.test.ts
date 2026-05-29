import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  inMemoryDeadLetterStore,
  sqliteDeadLetterStore,
} from "../../src/messaging/deadletter";
import { createMessageBus } from "../../src/messaging";
import { inMemoryTransport } from "../../src/messaging/transports/memory";
import type {
  DeadLetterEntry,
  DeadLetterStore,
  Message,
} from "../../src/messaging";

function message(id: string, payload: unknown = { id }): Message {
  return {
    id,
    type: "order.failed",
    payload,
    headers: { "x-tenant": "acme" },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    attempt: 0,
  };
}

function entry(id: string, payload?: unknown): DeadLetterEntry {
  return {
    message: message(id, payload),
    topic: "orders",
    error: { name: "Error", message: "boom" },
    attempts: 3,
    failedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const factories: Array<{ name: string; make: () => DeadLetterStore }> = [
  { name: "inMemoryDeadLetterStore", make: () => inMemoryDeadLetterStore() },
  { name: "sqliteDeadLetterStore", make: () => sqliteDeadLetterStore() },
];

for (const { name, make } of factories) {
  describe(name, () => {
    test("stores and lists entries newest-first", async () => {
      const dlq = make();
      await dlq.store(entry("a"));
      await dlq.store(entry("b"));
      const list = await dlq.list();
      expect(list.map((e) => e.message.id)).toEqual(["b", "a"]);
    });

    test("honors a list limit", async () => {
      const dlq = make();
      await dlq.store(entry("a"));
      await dlq.store(entry("b"));
      await dlq.store(entry("c"));
      const list = await dlq.list({ limit: 2 });
      expect(list.map((e) => e.message.id)).toEqual(["c", "b"]);
    });

    test("round-trips the full entry, preserving payload and timestamps", async () => {
      const dlq = make();
      await dlq.store(entry("a", { nested: { n: 1 }, arr: [1, 2] }));
      const [stored] = await dlq.list();
      expect(stored?.message.payload).toEqual({ nested: { n: 1 }, arr: [1, 2] });
      expect(stored?.message.headers).toEqual({ "x-tenant": "acme" });
      expect(stored?.attempts).toBe(3);
      expect(stored?.message.occurredAt.toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(stored?.failedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    });

    test("remove drops an entry", async () => {
      const dlq = make();
      await dlq.store(entry("a"));
      await dlq.remove("a");
      expect(await dlq.list()).toHaveLength(0);
    });

    test("redrive re-publishes the message to its source topic", async () => {
      const transport = inMemoryTransport();
      const bus = createMessageBus({ transport });
      const dlq = make();
      const received: Message[] = [];
      const handle = await transport.subscribe({
        topic: "order.failed",
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

      await dlq.store(entry("redrive-me", { hello: "world" }));
      await dlq.redrive("redrive-me", bus);

      const deadline = Date.now() + 1_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await handle.stop();

      expect(received).toHaveLength(1);
      expect(received[0]?.id).toBe("redrive-me");
      expect(received[0]?.payload).toEqual({ hello: "world" });
    });

    test("redrive throws for an unknown id", async () => {
      const dlq = make();
      const bus = createMessageBus({ transport: inMemoryTransport() });
      await expect(dlq.redrive("nope", bus)).rejects.toThrow();
    });
  });
}

describe("sqliteDeadLetterStore", () => {
  test("persists across store instances over the same database", async () => {
    const database = new Database(":memory:", { create: true });
    const first = sqliteDeadLetterStore({ database });
    await first.store(entry("a"));

    const second = sqliteDeadLetterStore({ database });
    const list = await second.list();
    expect(list.map((e) => e.message.id)).toEqual(["a"]);
  });

  test("continues newest-first ordering after reopening and storing", async () => {
    const database = new Database(":memory:", { create: true });
    const first = sqliteDeadLetterStore({ database });
    await first.store(entry("a"));

    const second = sqliteDeadLetterStore({ database });
    await second.store(entry("b"));

    const list = await second.list();
    expect(list.map((e) => e.message.id)).toEqual(["b", "a"]);
  });
});

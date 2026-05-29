import { describe, expect, test } from "bun:test";
import { createConsumer, createMessageBus } from "../../src/messaging";
import type { Message } from "../../src/messaging";
import { inMemoryDeadLetterStore } from "../../src/messaging/deadletter";
import { inMemoryInboxStore } from "../../src/messaging/inbox";
import { inMemoryTransport } from "../../src/messaging/transports/memory";
import { constantBackoff, retry } from "../../src/resilience";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("consumer retry → DLQ → redrive (end-to-end)", () => {
  test("message lands in DLQ after max retries, then redrive re-processes it", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();
    const inbox = inMemoryInboxStore();

    // Track every handler invocation with its attempt number.
    const handlerCalls: Array<{ id: string; attempt: number }> = [];
    // After redrive the handler should succeed; use a flag to control failure.
    let shouldFail = true;

    const consumer = createConsumer({
      transport,
      topic: "order.process",
      inbox,
      retry: retry({ maxAttempts: 3, backoff: constantBackoff(0) }),
      deadLetter: dlq,
      handler: (msg) => {
        handlerCalls.push({ id: msg.id, attempt: msg.attempt });
        if (shouldFail) {
          throw new Error("simulated processing failure");
        }
      },
    });
    await consumer.start();

    // --- Phase 1: publish a message that always fails -------------------------
    await bus.publish({
      type: "order.process",
      payload: { orderId: "abc-123", amount: 99.95 },
      id: "msg-001",
    });

    // Wait until the message is dead-lettered.
    await waitFor(async () => (await dlq.list()).length === 1);

    // The handler was called exactly maxAttempts times (3).
    expect(handlerCalls.filter((c) => c.id === "msg-001")).toHaveLength(3);

    // The DLQ contains the failed message with full diagnostic context.
    const parked = await dlq.list();
    expect(parked).toHaveLength(1);
    expect(parked[0]?.message.id).toBe("msg-001");
    expect(parked[0]?.message.type).toBe("order.process");
    expect(parked[0]?.message.payload).toEqual({ orderId: "abc-123", amount: 99.95 });
    expect(parked[0]?.topic).toBe("order.process");
    expect(parked[0]?.attempts).toBe(3);
    expect(parked[0]?.error.message).toBe("simulated processing failure");

    // --- Phase 2: fix the "bug" and redrive -----------------------------------
    shouldFail = false;

    // Clear earlier calls so we can verify just the redrive processing.
    const callsBefore = handlerCalls.length;

    await dlq.redrive("msg-001", bus);

    // Wait for the redriven message to be processed successfully.
    await waitFor(() => handlerCalls.length > callsBefore);
    // Give a brief window to confirm no further redeliveries.
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    // Exactly one additional handler call from the redrive.
    const redriveCalls = handlerCalls.slice(callsBefore);
    expect(redriveCalls).toHaveLength(1);
    expect(redriveCalls[0]?.id).toBe("msg-001");
  });

  test("multiple messages fail independently and can be redriven individually", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();

    const failingIds = new Set(["fail-1", "fail-2"]);
    const processed: string[] = [];

    const consumer = createConsumer({
      transport,
      topic: "multi.dlq",
      retry: retry({ maxAttempts: 2, backoff: constantBackoff(0) }),
      deadLetter: dlq,
      handler: (msg) => {
        if (failingIds.has(msg.id)) {
          throw new Error(`fail:${msg.id}`);
        }
        processed.push(msg.id);
      },
    });
    await consumer.start();

    // Publish three messages: two will fail, one will succeed.
    await bus.publish({ type: "multi.dlq", payload: {}, id: "ok-1" });
    await bus.publish({ type: "multi.dlq", payload: {}, id: "fail-1" });
    await bus.publish({ type: "multi.dlq", payload: {}, id: "fail-2" });

    await waitFor(async () => (await dlq.list()).length === 2);
    await waitFor(() => processed.includes("ok-1"));

    const parked = await dlq.list();
    const parkedIds = parked.map((e) => e.message.id);
    expect(parkedIds).toContain("fail-1");
    expect(parkedIds).toContain("fail-2");

    // Redrive only the first failed message (simulate a bug fix).
    failingIds.delete("fail-1");
    await dlq.redrive("fail-1", bus);
    await waitFor(() => processed.includes("fail-1"));
    await new Promise((r) => setTimeout(r, 50));

    expect(processed).toContain("ok-1");
    expect(processed).toContain("fail-1");
    expect(processed).not.toContain("fail-2");

    // Redrive the second.
    failingIds.delete("fail-2");
    await dlq.redrive("fail-2", bus);
    await waitFor(() => processed.includes("fail-2"));
    await consumer.stop();

    expect(processed).toContain("fail-2");
  });

  test("redrive preserves original message payload and headers", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();

    let captured: Message | undefined;
    let shouldFail = true;

    const consumer = createConsumer({
      transport,
      topic: "preserve",
      retry: retry({ maxAttempts: 1, backoff: constantBackoff(0) }),
      deadLetter: dlq,
      handler: (msg) => {
        if (shouldFail) throw new Error("fail");
        captured = msg;
      },
    });
    await consumer.start();

    await bus.publish({
      type: "preserve",
      payload: { key: "value", nested: [1, 2, 3] },
      id: "preserve-1",
      headers: { "x-tenant": "acme", "x-source": "test" },
    });

    await waitFor(async () => (await dlq.list()).length === 1);

    shouldFail = false;
    await dlq.redrive("preserve-1", bus);
    await waitFor(() => captured !== undefined);
    await consumer.stop();

    expect(captured!.id).toBe("preserve-1");
    expect(captured!.type).toBe("preserve");
    expect(captured!.payload).toEqual({ key: "value", nested: [1, 2, 3] });
    expect(captured!.headers["x-tenant"]).toBe("acme");
    expect(captured!.headers["x-source"]).toBe("test");
  });
});

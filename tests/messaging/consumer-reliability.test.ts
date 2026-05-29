import { describe, expect, test } from "bun:test";
import { createConsumer, createMessageBus } from "../../src/messaging";
import type { Attributes, InboxStore, MeterLike } from "../../src/messaging";
import { inMemoryInboxStore } from "../../src/messaging/inbox";
import { inMemoryDeadLetterStore } from "../../src/messaging/deadletter";
import { inMemoryTransport } from "../../src/messaging/transports/memory";
import { combine, constantBackoff, retry, timeout } from "../../src/resilience";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface CounterSample {
  readonly value: number;
  readonly attributes?: Attributes;
}

function recordingMeter(): {
  meter: MeterLike;
  counters: Map<string, CounterSample[]>;
} {
  const counters = new Map<string, CounterSample[]>();
  const instrument = (name: string) => {
    const samples: CounterSample[] = [];
    counters.set(name, samples);
    return {
      add(value: number, attributes?: Attributes) {
        samples.push({ value, attributes });
      },
    };
  };
  const meter: MeterLike = {
    createCounter: (name) => instrument(name),
    createHistogram: () => ({ record() {} }),
    createUpDownCounter: (name) => instrument(name),
  };
  return { meter, counters };
}

describe("consumer idempotency", () => {
  test("an inbox dedups a duplicate id and records messaging.inbox.deduped", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const { meter, counters } = recordingMeter();
    let handled = 0;
    const consumer = createConsumer({
      transport,
      topic: "idem",
      inbox: inMemoryInboxStore(),
      telemetry: { meter },
      handler: () => {
        handled += 1;
      },
    });
    await consumer.start();

    await bus.publish({ type: "idem", payload: {}, id: "same" });
    await waitFor(() => handled === 1);
    await bus.publish({ type: "idem", payload: {}, id: "same" });
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    expect(handled).toBe(1);
    const deduped = counters.get("messaging.inbox.deduped") ?? [];
    expect(deduped.length).toBe(1);
  });

  test("a custom idempotencyKey collapses messages with distinct ids", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let handled = 0;
    const consumer = createConsumer({
      transport,
      topic: "idem.key",
      inbox: inMemoryInboxStore(),
      idempotencyKey: (m) => String((m.payload as { orderId: string }).orderId),
      handler: () => {
        handled += 1;
      },
    });
    await consumer.start();

    await bus.publish({ type: "idem.key", payload: { orderId: "o1" }, id: "a" });
    await waitFor(() => handled === 1);
    await bus.publish({ type: "idem.key", payload: { orderId: "o1" }, id: "b" });
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    expect(handled).toBe(1);
  });

  test("passes configured inbox claim TTL to the inbox store", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let beginOpts: { ttlMs?: number } | undefined;
    let handled = false;
    const inbox: InboxStore = {
      async begin(_key, opts) {
        beginOpts = opts;
        return "new";
      },
      async commit() {},
      async release() {},
    };
    const consumer = createConsumer({
      transport,
      topic: "idem.ttl",
      inbox,
      inboxClaimTtlMs: 1_234,
      handler: () => {
        handled = true;
      },
    });
    await consumer.start();

    await bus.publish({ type: "idem.ttl", payload: {}, id: "ttl-1" });
    await waitFor(() => handled);
    await consumer.stop();

    expect(beginOpts).toEqual({ ttlMs: 1_234 });
  });
});

describe("consumer retry + dead-letter", () => {
  test("a real forge/resilience retry runs the handler up to maxAttempts", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    let attempts = 0;
    const consumer = createConsumer({
      transport,
      topic: "retry.dlq",
      retry: retry({ maxAttempts: 3, backoff: constantBackoff(0) }),
      deadLetter: inMemoryDeadLetterStore(),
      handler: () => {
        attempts += 1;
        throw new Error("always fails");
      },
    });
    await consumer.start();

    await bus.publish({ type: "retry.dlq", payload: { n: 1 }, id: "poison" });
    await waitFor(() => attempts >= 3);
    await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();

    // Exactly the bounded attempts, then parked — no transport redelivery.
    expect(attempts).toBe(3);
  });

  test("a poison message lands in the DLQ and records deadletter.size", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();
    const { meter, counters } = recordingMeter();
    const consumer = createConsumer({
      transport,
      topic: "dlq",
      retry: retry({ maxAttempts: 2, backoff: constantBackoff(0) }),
      deadLetter: dlq,
      telemetry: { meter },
      handler: () => {
        throw new Error("boom");
      },
    });
    await consumer.start();

    await bus.publish({ type: "dlq", payload: { id: 1 }, id: "p1" });
    await waitFor(async () => (await dlq.list()).length === 1);
    await consumer.stop();

    const parked = await dlq.list();
    expect(parked).toHaveLength(1);
    expect(parked[0]?.message.id).toBe("p1");
    expect(parked[0]?.attempts).toBe(2);
    expect(parked[0]?.error.message).toBe("boom");
    const size = counters.get("messaging.deadletter.size") ?? [];
    expect(size.length).toBe(1);
    expect(size[0]?.value).toBe(1);
  });

  test("a direct handler error keeps wrapper context in the DLQ", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();
    const consumer = createConsumer({
      transport,
      topic: "dlq.context",
      deadLetter: dlq,
      handler: () => {
        const cause = new Error("database unavailable");
        throw Object.assign(new Error("order projection failed"), { cause });
      },
    });
    await consumer.start();

    await bus.publish({ type: "dlq.context", payload: {}, id: "ctx-1" });
    await waitFor(async () => (await dlq.list()).length === 1);
    await consumer.stop();

    const parked = await dlq.list();
    expect(parked[0]?.error.message).toBe("order projection failed");
  });

  test("an undecodable body is dead-lettered rather than redelivered forever", async () => {
    const transport = inMemoryTransport();
    const dlq = inMemoryDeadLetterStore();
    let handlerCalls = 0;
    const consumer = createConsumer({
      transport,
      topic: "poison",
      deadLetter: dlq,
      handler: () => {
        handlerCalls += 1;
      },
    });
    await consumer.start();

    // Bypass the bus/codec to inject a body that is not valid JSON.
    await transport.send([
      {
        type: "poison",
        id: "bad-1",
        headers: {},
        body: new TextEncoder().encode("not json{"),
      },
    ]);
    await waitFor(async () => (await dlq.list()).length === 1);
    await consumer.stop();

    expect(handlerCalls).toBe(0);
    const parked = await dlq.list();
    expect(parked[0]?.message.id).toBe("bad-1");
    expect(parked[0]?.error.name).toBe("SerializationError");
  });

  test("a composed timeout aborts the in-flight handler signal", async () => {
    const transport = inMemoryTransport();
    const bus = createMessageBus({ transport });
    const dlq = inMemoryDeadLetterStore();
    let aborted = false;
    const consumer = createConsumer({
      transport,
      topic: "timeout",
      retry: combine(timeout({ ms: 20 })),
      deadLetter: dlq,
      handler: (_msg, ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    await consumer.start();

    await bus.publish({ type: "timeout", payload: {}, id: "slow-1" });
    await waitFor(async () => (await dlq.list()).length === 1, 2_000);
    await consumer.stop();

    expect(aborted).toBe(true);
    expect((await dlq.list())[0]?.message.id).toBe("slow-1");
  });
});

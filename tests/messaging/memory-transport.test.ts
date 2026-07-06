import { describe, expect, test } from "bun:test";
import { inMemoryTransport } from "../../src/messaging/transports/memory";
import type { TransportDelivery, TransportRecord } from "../../src/messaging";

function record(type: string, id = "1"): TransportRecord {
  return { type, id, headers: {}, body: new TextEncoder().encode("{}") };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("inMemoryTransport", () => {
  test("routes records to subscriptions matching the topic", async () => {
    const transport = inMemoryTransport();
    const a: TransportDelivery[] = [];
    const b: TransportDelivery[] = [];
    await transport.subscribe({
      topic: "a",
      onMessage: (d) => {
        a.push(d);
        d.ack();
      },
    });
    await transport.subscribe({
      topic: "b",
      onMessage: (d) => {
        b.push(d);
        d.ack();
      },
    });

    await transport.send([record("a"), record("b"), record("a")]);
    await waitFor(() => a.length === 2 && b.length === 1);
    await transport.shutdown();

    expect(a.length).toBe(2);
    expect(b.length).toBe(1);
  });

  test("a wildcard subscription receives every topic", async () => {
    const transport = inMemoryTransport();
    const all: string[] = [];
    await transport.subscribe({
      topic: "*",
      onMessage: (d) => {
        all.push(d.record.type);
        d.ack();
      },
    });
    await transport.send([record("x"), record("y")]);
    await waitFor(() => all.length === 2);
    await transport.shutdown();
    expect(all.sort()).toEqual(["x", "y"]);
  });

  test("a prefix wildcard subscription receives matching child topics", async () => {
    const transport = inMemoryTransport();
    const system: string[] = [];
    await transport.subscribe({
      topic: "system.*",
      onMessage: (d) => {
        system.push(d.record.type);
        d.ack();
      },
    });

    await transport.send([
      record("system.created"),
      record("system.updated.v2"),
      record("systemic.created"),
      record("system"),
    ]);
    await waitFor(() => system.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    await transport.shutdown();

    expect(system.sort()).toEqual(["system.created", "system.updated.v2"]);
  });

  test("drops a perpetually-nacked record after maxDeliveries", async () => {
    const transport = inMemoryTransport({ maxDeliveries: 3 });
    let deliveries = 0;
    await transport.subscribe({
      topic: "poison",
      onMessage: (d) => {
        deliveries += 1;
        d.nack();
      },
    });
    await transport.send([record("poison")]);
    // attempts 0,1,2 then dropped (nextAttempt 3 >= maxDeliveries).
    await waitFor(() => deliveries === 3);
    await new Promise((r) => setTimeout(r, 30));
    await transport.shutdown();
    expect(deliveries).toBe(3);
  });

  test("a missing ack/nack is treated as a nack (redelivery)", async () => {
    const transport = inMemoryTransport({ maxDeliveries: 2 });
    let deliveries = 0;
    await transport.subscribe({
      topic: "noack",
      onMessage: () => {
        deliveries += 1;
        // neither ack nor nack
      },
    });
    await transport.send([record("noack")]);
    await waitFor(() => deliveries === 2);
    await transport.shutdown();
    expect(deliveries).toBe(2);
  });

  test("stop() halts delivery to a subscription", async () => {
    const transport = inMemoryTransport();
    let count = 0;
    const handle = await transport.subscribe({
      topic: "t",
      onMessage: (d) => {
        count += 1;
        d.ack();
      },
    });
    await handle.stop();
    await transport.send([record("t")]);
    await new Promise((r) => setTimeout(r, 30));
    await transport.shutdown();
    expect(count).toBe(0);
  });
});

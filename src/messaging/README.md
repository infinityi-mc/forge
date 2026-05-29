# `forge/messaging`

`forge/messaging` is the asynchronous-work layer of Forge: publish a message
and move on, consume it reliably somewhere else. It is built on a few small,
swappable contracts — a `MessageBus` (publish), a `MessageConsumer` (consume),
a `Transport` (broker adapter), and a `Codec` (serialization) — each with a
real and an in-memory implementation.

Delivery is **at-least-once and unordered** by default. Effective
exactly-once (at-least-once delivery + idempotent consumption) and ordering
options arrive with the idempotency features in PR B.

## Shipped in PR A

- `createMessageBus` — resolves envelopes (id / headers / `occurredAt`),
  encodes via the `Codec`, and sends through a `Transport`. No global state.
- `createConsumer` — subscribes to a topic, decodes deliveries into `Message`s,
  runs the handler with bounded `concurrency`, and acks on success / nacks on
  failure (at-least-once redelivery). No dedup / DLQ yet.
- `jsonCodec` — the default `JSON` + UTF-8 codec; bring your own `Codec` for
  other wire formats.
- `inMemoryTransport` (`forge/messaging/transports/memory`) — in-process
  fan-out with a bounded per-subscription worker pool and nack-based
  redelivery, capped by `maxDeliveries` so a poison message can't spin forever.
- `MessagingError` taxonomy — `MessagingError` base + `TransportError`,
  `SerializationError`, `HandlerError`.
- `forge/messaging/testing` — `InMemoryMessageBus` (records `publishedEvents`),
  `createTestMessaging` harness, and `STANDARD_MESSAGING_SCENARIOS` +
  `assertConformance` for verifying bring-your-own transports.

## Upcoming

- **PR B** — idempotent consumers (`InboxStore`), bounded retry, and
  Dead Letter Queues; the full observability surface.
- **PR C** — the `forge/data` outbox relay, durable SQLite / Postgres
  transports, and background jobs.

## Quick start

```ts
import { createMessageBus, createConsumer } from "forge/messaging";
import { inMemoryTransport } from "forge/messaging/transports/memory";

const transport = inMemoryTransport();
const bus = createMessageBus({ transport });

const consumer = createConsumer({
  transport,
  topic: "order.placed",
  concurrency: 4,
  handler: async (msg, ctx) => {
    ctx.logger.info("processing order", { id: msg.id });
    await ship(msg.payload, { signal: ctx.signal });
  },
});

await consumer.start();
await bus.publish({ type: "order.placed", payload: { orderId: "123" } });
// ... later, on shutdown:
await consumer.stop();
await bus.shutdown();
```

## Testing

```ts
import { describe, it, expect } from "bun:test";
import { InMemoryMessageBus } from "forge/messaging/testing";

describe("Order Service", () => {
  it("publishes an event when an order is placed", async () => {
    const bus = new InMemoryMessageBus();
    await placeOrder(bus, { orderId: "123" });
    expect(bus.publishedEvents).toContainEqual({
      type: "OrderPlaced",
      payload: { orderId: "123" },
    });
  });
});
```

Verify a bring-your-own transport stays drop-in compatible:

```ts
import { assertConformance } from "forge/messaging/testing";
import { inMemoryTransport } from "forge/messaging/transports/memory";

await assertConformance(() => inMemoryTransport());
```

## Observability

The bus and consumers accept optional, **structurally-typed** `telemetry`
(`meter` / `tracer`) and `logger` handles — there is no hard dependency on
`forge/telemetry`. With no handles, nothing is emitted. When present:

| Signal | Kind |
| :-- | :-- |
| `messaging.messages.published` | counter |
| `messaging.publish.duration` | histogram (ms) |
| `messaging.messages.consumed` | counter (labels: `outcome`) |
| `messaging.consume.duration` | histogram (ms) |

## Constraints

- At-least-once delivery: handlers must tolerate duplicates (idempotency is
  PR B).
- `inMemoryTransport` is for tests and single-process fan-out — it is not
  durable. Durable transports arrive in PR C.

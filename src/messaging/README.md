# `forge/messaging`

`forge/messaging` is the asynchronous-work layer of Forge: publish a message
and move on, consume it reliably somewhere else. It is built on a few small,
swappable contracts — a `MessageBus` (publish), a `MessageConsumer` (consume),
a `Transport` (broker adapter), and a `Codec` (serialization) — each with a
real and an in-memory implementation.

Delivery is **at-least-once and unordered** by default. Pair an `InboxStore`
with at-least-once delivery for *effective exactly-once* consumption (PR B).

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

## Shipped in PR B

- **Idempotent consumption** — pass an `InboxStore` (and optional
  `idempotencyKey`) to `createConsumer`. Each message is claimed by key before
  the handler runs; duplicates are skipped, in-flight claims are left for
  redelivery. `inMemoryInboxStore` + durable `sqliteInboxStore` live behind
  `forge/messaging/inbox`.
- **Bounded retry** — pass a `retry` policy consumed **structurally** from
  `forge/resilience` (a `retry(...)` policy or a `combine(...)` pipeline; no
  hard dependency). The handler runs under a per-attempt `AbortSignal` that
  also trips on consumer stop, so a composed `timeout` cancels in-flight work.
- **Dead Letter Queues** — pass a `deadLetter` store; once retries are
  exhausted (or a body can't be decoded) the message is parked and the
  delivery acked, raising `MessageDroppedError` internally. `redrive` re-emits
  a parked message to its source topic. `inMemoryDeadLetterStore` + durable
  `sqliteDeadLetterStore` live behind `forge/messaging/deadletter`.
- **Observability** — `messaging.inbox.deduped` (counter),
  `messaging.deadletter.size` (up-down counter), and an `outcome="dead"` label
  on `messaging.messages.consumed`.
- **Errors** — adds `MessageDroppedError` and `IdempotencyError`.

> SQLite stores use `bun:sqlite` directly with row-atomic dedup. Sharing the
> *same* `forge/data` transaction as the handler's business write lands with
> the outbox relay in PR C.

## Upcoming

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
```

Make consumption reliable — dedup duplicates, retry transient failures, and
park poison messages:

```ts
import { createConsumer } from "forge/messaging";
import { inMemoryInboxStore } from "forge/messaging/inbox";
import { inMemoryDeadLetterStore } from "forge/messaging/deadletter";
import { retry, exponentialBackoff } from "forge/resilience";

const consumer = createConsumer({
  transport,
  topic: "order.placed",
  inbox: inMemoryInboxStore(),
  retry: retry({ maxAttempts: 5, backoff: exponentialBackoff() }),
  deadLetter: inMemoryDeadLetterStore(),
  handler: async (msg, ctx) => {
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
| `messaging.messages.consumed` | counter (labels: `outcome` = `ok` / `retry` / `dead`) |
| `messaging.consume.duration` | histogram (ms) |
| `messaging.inbox.deduped` | counter |
| `messaging.deadletter.size` | up-down counter |

## Constraints

- At-least-once delivery: handlers must tolerate duplicates. Add an
  `InboxStore` for effective exactly-once consumption.
- `inMemoryTransport` and the in-memory stores are for tests and
  single-process fan-out — they are not durable. Durable transports arrive in
  PR C; durable `sqlite*` stores ship in PR B.

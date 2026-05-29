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
  redelivery. Set `inboxClaimTtlMs` with durable stores so crash-orphaned
  in-flight claims can be reclaimed. `inMemoryInboxStore` + durable
  `sqliteInboxStore` live behind `forge/messaging/inbox`.
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

## Shipped in PR C

- **Outbox relay** — `createOutboxRelay({ db, bus })` (behind
  `forge/messaging/outbox`) polls `forge/data`'s transactional outbox
  (`_forge_outbox`) and forwards undelivered rows to a `MessageBus`, marking
  them dispatched. The producer writes its business row and the outbox row in
  the *same* transaction (`tx.outbox.publish(...)`); the relay delivers them
  at-least-once — pair it with an `InboxStore` for effective exactly-once. It
  depends on a **structural** `DbLike` slice, so a real `forge/data` `Db` is
  drop-in with no import. The relay idempotently adds three
  forward-compatible columns (`dispatched_at`, `attempts`, `available_at`) to
  the outbox table on start.
- **Durable transports** — `sqliteTransport` (`forge/messaging/transports/sqlite`)
  is a single-node `bun:sqlite`-backed queue; `postgresTransport`
  (`forge/messaging/transports/postgres`) is a multi-node queue that claims
  rows with `FOR UPDATE SKIP LOCKED` and wakes workers via `LISTEN`/`NOTIFY`.
  Both survive restarts, deliver at-least-once with competing-consumer
  semantics, and pass `STANDARD_MESSAGING_SCENARIOS`. `postgresTransport`
  talks to a structural client (a `node-postgres` `Client`/`Pool` drops in).
- **Background jobs** — `createJobQueue` (`enqueue` / `schedule` / `every`) and
  `createWorker` (behind `forge/messaging/jobs`) over a `JobStore`
  (`inMemoryJobStore` + durable `sqliteJobStore`). Workers claim jobs with
  skip-locked semantics, reuse the consumer's retry → dead-letter machinery,
  and re-schedule recurring `every(...)` jobs single-flight.
- **Observability** — `messaging.outbox.pending` (up-down counter),
  `messaging.outbox.dispatched` (counter), and
  `messaging.jobs.{enqueued,completed,failed}` (counters).
- **Errors** — adds `OutboxRelayError` and `JobError`.

> The outbox relay realizes the "same `forge/data` transaction as the business
> write" story the PR B stores deferred: the write and the outbox row commit
> together, and the relay handles delivery.

## Lifecycle

The relay, worker, and consumer all expose `start()` / `stop()`, so they slot
into a `forge/lifecycle` supervisor once that module lands. No lifecycle
integration is wired here.

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
  inboxClaimTtlMs: 60_000,
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

Relay `forge/data`'s transactional outbox to the bus — the business write and
the event commit atomically, the relay delivers at-least-once:

```ts
import { createMessageBus } from "forge/messaging";
import { createOutboxRelay } from "forge/messaging/outbox";
import { postgresTransport } from "forge/messaging/transports/postgres";

const bus = createMessageBus({ transport: postgresTransport({ client }) });
const relay = createOutboxRelay({ db, bus }); // `db` is a forge/data Db
await relay.start();

// elsewhere, the producer writes business state + the event in one tx:
await db.transaction(async (tx) => {
  await tx.insertInto("orders").values(order).execute();
  await tx.outbox.publish("order.placed", { orderId: order.id });
});
```

Run durable background jobs — now, scheduled, or recurring:

```ts
import { createJobQueue, createWorker, sqliteJobStore } from "forge/messaging/jobs";

const store = sqliteJobStore({ filename: "./jobs.db" });
const queue = createJobQueue({ store });
const worker = createWorker({
  store,
  concurrency: 8,
  handlers: {
    "email.send": async (job, ctx) => sendEmail(job.payload, { signal: ctx.signal }),
  },
});
await worker.start();

await queue.enqueue("email.send", { to: "a@b.c" });
await queue.schedule("email.send", new Date(Date.now() + 60_000), { to: "later@b.c" });
await queue.every("report.daily", 86_400_000);
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
| `messaging.outbox.pending` | up-down counter |
| `messaging.outbox.dispatched` | counter |
| `messaging.jobs.enqueued` | counter |
| `messaging.jobs.completed` | counter |
| `messaging.jobs.failed` | counter |

## Constraints

- At-least-once delivery: handlers must tolerate duplicates. Add an
  `InboxStore` for effective exactly-once consumption.
- `inMemoryTransport` and the in-memory stores are for tests and
  single-process fan-out — they are not durable. Use `sqliteTransport` /
  `postgresTransport` and the `sqlite*` stores for durability.
- Delivery is unordered at-least-once; per-key FIFO ordering for the relay and
  transports is not yet implemented.
- Background-job scheduling is single-node single-flight; multi-node leader
  election for `every(...)` is out of scope.

/**
 * Conformance scenarios for `forge/messaging` transports.
 *
 * `STANDARD_MESSAGING_SCENARIOS` exercises the invariants every
 * well-formed {@link Transport} must satisfy when driven through a
 * {@link MessageBus} and {@link MessageConsumer}:
 *
 * - A published payload round-trips unchanged to the handler.
 * - Headers set by the producer reach the consumer.
 * - Delivery is at-least-once: a nacked message (a handler that throws
 *   on its first delivery) is redelivered and eventually handled.
 * - An {@link InboxStore} makes consumption idempotent: a duplicate
 *   delivery (same id) runs the handler only once.
 * - A handler that always fails lands in a {@link DeadLetterStore} once
 *   its bounded retries are exhausted — and can be redriven back to its
 *   source topic.
 *
 * Each scenario receives a {@link TransportFactory} that returns a fresh
 * transport, so scenarios never share state. Errors are plain `Error`s,
 * keeping the suite framework-agnostic — run it from `bun:test` or any
 * other runner.
 *
 * @module
 */

import { createMessageBus } from "../bus";
import { createConsumer } from "../consumer";
import { inMemoryDeadLetterStore } from "../deadletter";
import { inMemoryInboxStore } from "../inbox";
import { createOutboxRelay } from "../outbox";
import type { DbLike } from "../outbox";
import { createJobQueue, createWorker } from "../jobs";
import type { JobStore } from "../jobs";
import type {
  Message,
  MessageBus,
  PublishMessage,
  MessageConsumer,
  RetryExecutionContext,
  RetryOperation,
  RetryPolicyLike,
  Transport,
} from "../types";

/**
 * A minimal {@link RetryPolicyLike} that runs the operation up to
 * `maxAttempts` times. Kept local so the conformance suite stays
 * decoupled from `forge/resilience` — production code passes a real
 * `retry(...)` / `combine(...)` instead.
 */
function fixedAttempts(maxAttempts: number): RetryPolicyLike {
  return {
    async execute<T>(
      operation: RetryOperation<T>,
      ctx: RetryExecutionContext,
    ): Promise<T> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await operation({ signal: ctx.signal, attempt });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

/** Returns a fresh {@link Transport} for each scenario run. */
export type TransportFactory = () => Transport | Promise<Transport>;

/** A single conformance scenario. `run` throws an `Error` on violation. */
export interface MessagingConformanceScenario {
  readonly name: string;
  run(factory: TransportFactory): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance violation: ${message}`);
}

/** Resolve once `predicate` is true or throw after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withConsumer(
  consumer: MessageConsumer,
  fn: () => Promise<void>,
): Promise<void> {
  await consumer.start();
  try {
    await fn();
  } finally {
    await consumer.stop();
  }
}

/** Scenarios that hold for every well-formed transport. */
export const STANDARD_MESSAGING_SCENARIOS: readonly MessagingConformanceScenario[] = [
  {
    name: "delivers a published payload unchanged to a subscribed consumer",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      const received: Message[] = [];
      const consumer = createConsumer({
        transport,
        topic: "conformance.echo",
        handler: (msg) => {
          received.push(msg);
        },
      });

      await withConsumer(consumer, async () => {
        await bus.publish({
          type: "conformance.echo",
          payload: { hello: "world", n: 42 },
        });
        await waitFor(() => received.length === 1, "one delivery");
      });

      assert(received.length === 1, "expected exactly one delivery");
      const message = received[0];
      assert(message !== undefined, "delivery present");
      assert(message.type === "conformance.echo", "type round-trips");
      assert(
        JSON.stringify(message.payload) ===
          JSON.stringify({ hello: "world", n: 42 }),
        "payload round-trips unchanged",
      );
      await bus.shutdown();
    },
  },
  {
    name: "propagates producer headers to the consumer",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      let seen: Message | undefined;
      const consumer = createConsumer({
        transport,
        topic: "conformance.headers",
        handler: (msg) => {
          seen = msg;
        },
      });

      await withConsumer(consumer, async () => {
        await bus.publish({
          type: "conformance.headers",
          payload: {},
          headers: { "x-tenant": "acme" },
        });
        await waitFor(() => seen !== undefined, "one delivery");
      });

      assert(seen !== undefined, "message received");
      assert(seen.headers["x-tenant"] === "acme", "header round-trips");
      await bus.shutdown();
    },
  },
  {
    name: "redelivers an at-least-once message after a handler failure",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      let attempts = 0;
      const consumer = createConsumer({
        transport,
        topic: "conformance.retry",
        handler: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("fail first delivery");
        },
      });

      await withConsumer(consumer, async () => {
        await bus.publish({ type: "conformance.retry", payload: { id: 1 } });
        await waitFor(() => attempts >= 2, "redelivery after failure");
      });

      assert(attempts >= 2, "expected the message to be redelivered");
      await bus.shutdown();
    },
  },
  {
    name: "dedups a duplicate delivery through an inbox store",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      let handled = 0;
      const consumer = createConsumer({
        transport,
        topic: "conformance.idempotent",
        inbox: inMemoryInboxStore(),
        handler: () => {
          handled += 1;
        },
      });

      await withConsumer(consumer, async () => {
        // Same id twice: the second delivery must be suppressed.
        await bus.publish({
          type: "conformance.idempotent",
          payload: { n: 1 },
          id: "dup-1",
        });
        await waitFor(() => handled === 1, "first delivery handled");
        await bus.publish({
          type: "conformance.idempotent",
          payload: { n: 1 },
          id: "dup-1",
        });
        // Give a (wrongful) second invocation a chance to occur.
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      assert(handled === 1, "handler ran exactly once for a duplicate id");
      await bus.shutdown();
    },
  },
  {
    name: "dead-letters a message once its retries are exhausted",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      const deadLetter = inMemoryDeadLetterStore();
      let attempts = 0;
      const consumer = createConsumer({
        transport,
        topic: "conformance.dlq",
        retry: fixedAttempts(3),
        deadLetter,
        handler: () => {
          attempts += 1;
          throw new Error("always fails");
        },
      });

      let parked: readonly Message[] = [];
      await withConsumer(consumer, async () => {
        await bus.publish({
          type: "conformance.dlq",
          payload: { id: "poison-1" },
          id: "poison-1",
        });
        await waitFor(async () => {
          const list = await deadLetter.list();
          return list.length === 1;
        }, "message lands in the DLQ");
        parked = (await deadLetter.list()).map((e) => e.message);
      });

      assert(attempts === 3, "handler ran for every bounded attempt");
      assert(parked.length === 1, "exactly one message dead-lettered");
      assert(parked[0]?.id === "poison-1", "the failing message was parked");
      await bus.shutdown();
    },
  },
  {
    name: "redrives a dead-lettered message back to its source topic",
    async run(factory) {
      const transport = await factory();
      const bus = createMessageBus({ transport });
      const deadLetter = inMemoryDeadLetterStore();
      let attempts = 0;
      const consumer = createConsumer({
        transport,
        topic: "conformance.redrive",
        retry: fixedAttempts(1),
        deadLetter,
        handler: () => {
          attempts += 1;
          throw new Error("always fails");
        },
      });

      await withConsumer(consumer, async () => {
        await bus.publish({
          type: "conformance.redrive",
          payload: {},
          id: "redrive-1",
        });
        await waitFor(async () => (await deadLetter.list()).length === 1, "initial DLQ");
        const attemptsBeforeRedrive = attempts;

        await deadLetter.redrive("redrive-1", bus);
        await waitFor(
          () => attempts > attemptsBeforeRedrive,
          "handler re-invoked after redrive",
        );
        assert(
          attempts > attemptsBeforeRedrive,
          "redrive re-published to the source topic",
        );
      });

      await bus.shutdown();
    },
  },
];

/**
 * Run conformance scenarios against a transport factory, throwing on the
 * first violation. Defaults to {@link STANDARD_MESSAGING_SCENARIOS}.
 *
 * @example
 * ```ts
 * import { assertConformance } from "forge/messaging/testing";
 * import { inMemoryTransport } from "forge/messaging/transports/memory";
 *
 * await assertConformance(() => inMemoryTransport());
 * ```
 */
export async function assertConformance(
  factory: TransportFactory,
  scenarios: readonly MessagingConformanceScenario[] = STANDARD_MESSAGING_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Scenario "${scenario.name}" failed: ${reason}`, {
        cause,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Outbox relay conformance                                                   */
/* -------------------------------------------------------------------------- */

/** A bus double recording published messages, local to the suite. */
class RecordingBus implements MessageBus {
  readonly messages: Message[] = [];
  async publish<T>(message: PublishMessage<T>): Promise<void> {
    this.messages.push({
      id: message.id ?? `${this.messages.length}`,
      type: message.type,
      payload: message.payload,
      headers: { ...(message.headers ?? {}) },
      occurredAt: message.occurredAt ?? new Date(),
      attempt: 1,
    });
  }
  async publishBatch<T>(messages: readonly PublishMessage<T>[]): Promise<void> {
    for (const message of messages) await this.publish(message);
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * Harness an outbox-relay scenario drives: a structural {@link DbLike}
 * over an outbox table, plus an `insert` that writes a pending row the
 * way `forge/data`'s `tx.outbox.publish` would. Every `forge/data`
 * dialect can supply one to verify the relay end-to-end.
 */
export interface OutboxRelayHarness {
  readonly db: DbLike;
  /** Insert a pending outbox row. */
  insert(row: {
    type: string;
    payload: string;
    metadata: string;
    occurredAt: string;
  }): Promise<void>;
}

/** Returns a fresh {@link OutboxRelayHarness} per scenario run. */
export type OutboxRelayHarnessFactory = () =>
  | OutboxRelayHarness
  | Promise<OutboxRelayHarness>;

/** A single outbox-relay conformance scenario. */
export interface OutboxRelayConformanceScenario {
  readonly name: string;
  run(factory: OutboxRelayHarnessFactory): Promise<void>;
}

/** Scenarios that hold for every well-formed outbox relay setup. */
export const STANDARD_OUTBOX_RELAY_SCENARIOS: readonly OutboxRelayConformanceScenario[] =
  [
    {
      name: "dispatches pending rows to the bus in order",
      async run(factory) {
        const harness = await factory();
        await harness.insert({
          type: "thing.happened",
          payload: JSON.stringify({ n: 1 }),
          metadata: JSON.stringify({}),
          occurredAt: new Date().toISOString(),
        });
        await harness.insert({
          type: "thing.happened",
          payload: JSON.stringify({ n: 2 }),
          metadata: JSON.stringify({}),
          occurredAt: new Date().toISOString(),
        });
        const bus = new RecordingBus();
        const relay = createOutboxRelay({ db: harness.db, bus });
        const dispatched = await relay.drainOnce();
        assert(dispatched === 2, "both pending rows dispatched");
        assert(
          bus.messages.map((m) => (m.payload as { n: number }).n).join(",") ===
            "1,2",
          "rows dispatched in insertion order",
        );
      },
    },
    {
      name: "marks rows dispatched so a second drain re-publishes nothing",
      async run(factory) {
        const harness = await factory();
        await harness.insert({
          type: "once.only",
          payload: JSON.stringify({}),
          metadata: JSON.stringify({}),
          occurredAt: new Date().toISOString(),
        });
        const bus = new RecordingBus();
        const relay = createOutboxRelay({ db: harness.db, bus });
        assert((await relay.drainOnce()) === 1, "first drain dispatches");
        assert((await relay.drainOnce()) === 0, "second drain is a no-op");
        assert(bus.messages.length === 1, "row published exactly once");
      },
    },
  ];

/** Run outbox-relay scenarios against a harness factory. */
export async function assertOutboxRelayConformance(
  factory: OutboxRelayHarnessFactory,
  scenarios: readonly OutboxRelayConformanceScenario[] = STANDARD_OUTBOX_RELAY_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Outbox scenario "${scenario.name}" failed: ${reason}`, {
        cause,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Job store conformance                                                      */
/* -------------------------------------------------------------------------- */

/** Returns a fresh {@link JobStore} per scenario run. */
export type JobStoreFactory = () => JobStore | Promise<JobStore>;

/** A single job-store conformance scenario. */
export interface JobStoreConformanceScenario {
  readonly name: string;
  run(factory: JobStoreFactory): Promise<void>;
}

/** Scenarios that hold for every well-formed {@link JobStore}. */
export const STANDARD_JOB_STORE_SCENARIOS: readonly JobStoreConformanceScenario[] =
  [
    {
      name: "runs an enqueued job exactly once",
      async run(factory) {
        const store = await factory();
        const queue = createJobQueue({ store });
        const seen: unknown[] = [];
        const worker = createWorker({
          store,
          pollIntervalMs: 5,
          handler: (job) => {
            seen.push(job.payload);
          },
        });
        await worker.start();
        await queue.enqueue("conformance.job", { ok: true });
        await waitFor(() => seen.length === 1, "job ran");
        await worker.stop();
        assert(seen.length === 1, "handler ran exactly once");
        assert((await store.size()) === 0, "completed job removed");
      },
    },
    {
      name: "claims a job once across concurrent workers",
      async run(factory) {
        const store = await factory();
        const queue = createJobQueue({ store });
        const counts = new Map<number, number>();
        const worker = createWorker({
          store,
          concurrency: 4,
          pollIntervalMs: 2,
          handler: (job) => {
            const id = (job.payload as { id: number }).id;
            counts.set(id, (counts.get(id) ?? 0) + 1);
          },
        });
        await worker.start();
        for (let i = 0; i < 10; i += 1) await queue.enqueue("c", { id: i });
        await waitFor(() => counts.size === 10, "all jobs ran", 3_000);
        await worker.stop();
        assert(counts.size === 10, "every job ran");
        for (const n of counts.values()) {
          assert(n === 1, "no job ran more than once");
        }
      },
    },
    {
      name: "dead-letters a job once its attempts are exhausted",
      async run(factory) {
        const store = await factory();
        const queue = createJobQueue({ store });
        const deadLetter = inMemoryDeadLetterStore();
        let attempts = 0;
        const worker = createWorker({
          store,
          deadLetter,
          pollIntervalMs: 5,
          backoff: () => 0,
          handler: () => {
            attempts += 1;
            throw new Error("always fails");
          },
        });
        await worker.start();
        await queue.enqueue("poison", {}, { maxAttempts: 3 });
        await waitFor(
          async () => (await deadLetter.list()).length === 1,
          "job dead-lettered",
          3_000,
        );
        await worker.stop();
        assert(attempts === 3, "ran for every bounded attempt");
        assert((await store.size()) === 0, "exhausted job removed");
      },
    },
  ];

/** Run job-store scenarios against a store factory. */
export async function assertJobStoreConformance(
  factory: JobStoreFactory,
  scenarios: readonly JobStoreConformanceScenario[] = STANDARD_JOB_STORE_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Job scenario "${scenario.name}" failed: ${reason}`, {
        cause,
      });
    }
  }
}

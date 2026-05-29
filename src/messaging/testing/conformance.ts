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
 *
 * Each scenario receives a {@link TransportFactory} that returns a fresh
 * transport, so scenarios never share state. Errors are plain `Error`s,
 * keeping the suite framework-agnostic — run it from `bun:test` or any
 * other runner.
 *
 * Idempotency and dead-letter scenarios are added alongside the PR B
 * features they verify.
 *
 * @module
 */

import { createMessageBus } from "../bus";
import { createConsumer } from "../consumer";
import type { Message, MessageConsumer, Transport } from "../types";

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
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
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

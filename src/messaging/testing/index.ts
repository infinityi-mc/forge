/**
 * Test helpers for `forge/messaging`.
 *
 * Ships the in-memory {@link InMemoryMessageBus} double (the one the
 * project README uses to assert published events), a one-call
 * {@link createTestMessaging} harness that wires a bus to an
 * `inMemoryTransport`, and the {@link STANDARD_MESSAGING_SCENARIOS}
 * conformance suite for verifying bring-your-own transports.
 *
 * @module
 */

export {
  STANDARD_MESSAGING_SCENARIOS,
  assertConformance,
  type MessagingConformanceScenario,
  type TransportFactory,
} from "./conformance";

import { jsonCodec, type Codec } from "../codec";
import { inMemoryTransport } from "../transports/memory";
import { createMessageBus } from "../bus";
import { createConsumer } from "../consumer";
import type {
  ConsumerOptions,
  Message,
  MessageBus,
  MessageConsumer,
  PublishMessage,
  Transport,
} from "../types";

/** A recorded publish in the README-friendly `{ type, payload }` shape. */
export interface PublishedEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** Options for {@link InMemoryMessageBus}. */
export interface InMemoryMessageBusOptions {
  /**
   * Optional transport to forward publishes to, so consumers wired to
   * the same transport actually receive what was published. When
   * omitted the bus only records.
   */
  readonly transport?: Transport;
  /** Codec used when forwarding to a transport. Default {@link jsonCodec}. */
  readonly codec?: Codec;
  /** Headers merged under every published message's own headers. */
  readonly defaultHeaders?: Record<string, string>;
  /** Id factory for messages without an explicit id. Default UUID. */
  readonly idGenerator?: () => string;
}

/**
 * An in-memory {@link MessageBus} double for unit tests. Records every
 * publish as a full {@link Message} (see {@link messages}) and in the
 * README's `{ type, payload }` shape (see {@link publishedEvents}).
 *
 * @example
 * ```ts
 * import { InMemoryMessageBus } from "forge/messaging/testing";
 *
 * const bus = new InMemoryMessageBus();
 * await placeOrder(bus, { orderId: "123" });
 * expect(bus.publishedEvents).toContainEqual({
 *   type: "OrderPlaced",
 *   payload: { orderId: "123" },
 * });
 * ```
 */
export class InMemoryMessageBus implements MessageBus {
  private readonly recorded: Message[] = [];
  private readonly forward?: MessageBus;
  private readonly defaultHeaders: Record<string, string>;
  private readonly idGenerator: () => string;

  constructor(options: InMemoryMessageBusOptions = {}) {
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    if (options.transport !== undefined) {
      this.forward = createMessageBus({
        transport: options.transport,
        codec: options.codec ?? jsonCodec(),
        defaultHeaders: this.defaultHeaders,
        idGenerator: this.idGenerator,
      });
    }
  }

  /** Every published message, as full envelopes, in publish order. */
  get messages(): readonly Message[] {
    return this.recorded;
  }

  /** Every published message in the README's `{ type, payload }` shape. */
  get publishedEvents(): readonly PublishedEvent[] {
    return this.recorded.map((m) => ({ type: m.type, payload: m.payload }));
  }

  /** Discard all recorded messages. */
  clear(): void {
    this.recorded.length = 0;
  }

  private record(message: PublishMessage): void {
    this.recorded.push({
      id: message.id ?? this.idGenerator(),
      type: message.type,
      payload: message.payload,
      headers: { ...this.defaultHeaders, ...(message.headers ?? {}) },
      occurredAt: message.occurredAt ?? new Date(),
      attempt: 0,
    });
  }

  async publish<T>(message: PublishMessage<T>): Promise<void> {
    this.record(message);
    await this.forward?.publish(message);
  }

  async publishBatch(messages: readonly PublishMessage[]): Promise<void> {
    for (const message of messages) this.record(message);
    await this.forward?.publishBatch(messages);
  }

  async flush(): Promise<void> {
    await this.forward?.flush();
  }

  async shutdown(): Promise<void> {
    await this.forward?.shutdown();
  }
}

/** Handle returned by {@link createTestMessaging}. */
export interface TestMessagingHarness {
  /** The shared in-process transport. */
  readonly transport: Transport;
  /** A bus that records publishes and forwards them to {@link transport}. */
  readonly bus: InMemoryMessageBus;
  /** Build a consumer bound to {@link transport}. */
  consumer(
    topic: string,
    handler: ConsumerOptions["handler"],
    options?: Omit<ConsumerOptions, "transport" | "topic" | "handler">,
  ): MessageConsumer;
}

/**
 * One-call wiring of the primitives most messaging tests need: a shared
 * `inMemoryTransport`, an {@link InMemoryMessageBus} forwarding to it,
 * and a {@link consumer} factory. Mirrors `createTestResilience` /
 * `createTestTelemetry`.
 *
 * @example
 * ```ts
 * import { createTestMessaging } from "forge/messaging/testing";
 *
 * const t = createTestMessaging();
 * const consumer = t.consumer("order.placed", (msg) => handle(msg));
 * await consumer.start();
 * await t.bus.publish({ type: "order.placed", payload: { orderId: "1" } });
 * ```
 */
export function createTestMessaging(): TestMessagingHarness {
  const transport = inMemoryTransport();
  const bus = new InMemoryMessageBus({ transport });
  return {
    transport,
    bus,
    consumer(topic, handler, options) {
      return createConsumer({ ...options, transport, topic, handler });
    },
  };
}

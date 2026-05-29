/**
 * `forge/messaging` — the asynchronous-work layer of Forge.
 *
 * PR A ships the publish/consume core: a {@link MessageBus} and
 * {@link MessageConsumer} built on a tiny {@link Transport} contract,
 * a pluggable {@link Codec} (default JSON), the in-process
 * `inMemoryTransport`, and the {@link MessagingError} taxonomy. Delivery
 * is at-least-once and unordered.
 *
 * Idempotent consumers + dead-letter queues (PR B) and the
 * `forge/data` outbox relay + durable transports + background jobs
 * (PR C) build on these contracts.
 *
 * Transports live behind their own entrypoint, e.g.
 * `forge/messaging/transports/memory`, and test doubles behind
 * `forge/messaging/testing`.
 *
 * @example
 * ```ts
 * import { createMessageBus, createConsumer } from "forge/messaging";
 * import { inMemoryTransport } from "forge/messaging/transports/memory";
 *
 * const transport = inMemoryTransport();
 * const bus = createMessageBus({ transport });
 *
 * const consumer = createConsumer({
 *   transport,
 *   topic: "order.placed",
 *   handler: async (msg) => console.log(msg.payload),
 * });
 * await consumer.start();
 * await bus.publish({ type: "order.placed", payload: { orderId: "123" } });
 * ```
 *
 * @module
 */

export { createMessageBus } from "./bus";
export { createConsumer } from "./consumer";
export { jsonCodec } from "./codec";
export type { Codec } from "./codec";

export {
  HandlerError,
  MessagingError,
  SerializationError,
  TransportError,
} from "./errors";

export type {
  Attributes,
  ConsumeContext,
  ConsumerOptions,
  CounterLike,
  HistogramLike,
  Logger,
  LogAttributes,
  Message,
  MessageBus,
  MessageBusOptions,
  MessageConsumer,
  MessageHandler,
  MessagingTelemetry,
  MeterLike,
  PublishMessage,
  SpanLike,
  TracerLike,
  Transport,
  TransportDelivery,
  TransportHandle,
  TransportRecord,
  TransportSubscription,
} from "./types";

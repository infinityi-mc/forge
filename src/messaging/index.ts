/**
 * `forge/messaging` — the asynchronous-work layer of Forge.
 *
 * PR A ships the publish/consume core: a {@link MessageBus} and
 * {@link MessageConsumer} built on a tiny {@link Transport} contract,
 * a pluggable {@link Codec} (default JSON), the in-process
 * `inMemoryTransport`, and the {@link MessagingError} taxonomy. Delivery
 * is at-least-once and unordered.
 *
 * PR B adds the reliability surface: idempotent consumption via an
 * {@link InboxStore} (`forge/messaging/inbox`), bounded retry consumed
 * structurally from `forge/resilience`, and {@link DeadLetterStore}
 * dead-lettering with redrive (`forge/messaging/deadletter`).
 *
 * PR C adds the durable/at-scale surface: the `forge/data` outbox relay
 * (`forge/messaging/outbox`), a durable `sqliteTransport` and
 * `postgresTransport` (`forge/messaging/transports/{sqlite,postgres}`),
 * and background jobs (`forge/messaging/jobs`).
 *
 * Transports live behind their own entrypoint, e.g.
 * `forge/messaging/transports/memory`; stores behind
 * `forge/messaging/inbox` and `forge/messaging/deadletter`; and test
 * doubles behind `forge/messaging/testing`.
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
  IdempotencyError,
  JobError,
  MessageDroppedError,
  MessagingError,
  OutboxRelayError,
  SerializationError,
  TransportError,
} from "./errors";

export type {
  Attributes,
  Clock,
  ConsumeContext,
  ConsumerOptions,
  CounterLike,
  DeadLetterEntry,
  DeadLetterStore,
  HistogramLike,
  InboxState,
  InboxStore,
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
  RetryExecutionContext,
  RetryOperation,
  RetryPolicyLike,
  SpanLike,
  TracerLike,
  Transport,
  TransportDelivery,
  TransportHandle,
  TransportRecord,
  TransportSubscription,
  UpDownCounterLike,
} from "./types";

/**
 * `createMessageBus` — the publish side of `forge/messaging`.
 *
 * The bus resolves each {@link PublishMessage} into a full envelope
 * (generating an `id`, merging default headers, stamping `occurredAt`),
 * encodes the payload via the {@link Codec}, and hands the resulting
 * {@link TransportRecord}s to the {@link Transport}. It holds no broker
 * state of its own — that lives in the transport.
 *
 * @module
 */

import { jsonCodec, type Codec } from "./codec";
import { TransportError } from "./errors";
import { createMetrics, now, NOOP_LOGGER, withSpan } from "./observability";
import { toRecord, type OutgoingMessage } from "./protocol";
import type {
  Logger,
  MessageBus,
  MessageBusOptions,
  MessagingTelemetry,
  PublishMessage,
  Transport,
  TransportRecord,
} from "./types";

/**
 * Create a {@link MessageBus} over the given {@link Transport}.
 *
 * @example
 * ```ts
 * import { createMessageBus } from "forge/messaging";
 * import { inMemoryTransport } from "forge/messaging/transports/memory";
 *
 * const bus = createMessageBus({ transport: inMemoryTransport() });
 * await bus.publish({ type: "order.placed", payload: { orderId: "123" } });
 * ```
 */
export function createMessageBus(options: MessageBusOptions): MessageBus {
  const transport: Transport = options.transport;
  const codec: Codec = options.codec ?? jsonCodec();
  const defaultHeaders = options.defaultHeaders ?? {};
  const telemetry: MessagingTelemetry | undefined = options.telemetry;
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  const metrics = createMetrics(telemetry);

  const resolve = (message: PublishMessage): OutgoingMessage => ({
    id: message.id ?? idGenerator(),
    type: message.type,
    payload: message.payload,
    headers: { ...defaultHeaders, ...(message.headers ?? {}) },
    occurredAt: message.occurredAt ?? new Date(),
  });

  const send = async (
    records: readonly TransportRecord[],
    types: readonly string[],
  ): Promise<void> => {
    try {
      await transport.send(records);
    } catch (cause) {
      logger.error("messaging.publish.failed", {
        transport: transport.name,
        count: records.length,
      });
      throw new TransportError(
        `Transport "${transport.name}" failed to send ${records.length} record(s)`,
        { cause, transport: transport.name },
      );
    }
    for (const type of types) {
      metrics.published.add(1, { type, transport: transport.name });
    }
  };

  return {
    async publish<T>(message: PublishMessage<T>): Promise<void> {
      const resolved = resolve(message);
      const started = now();
      await withSpan(
        telemetry?.tracer,
        `publish ${resolved.type}`,
        {
          kind: "producer",
          attributes: {
            "messaging.system": "forge",
            "messaging.destination.name": resolved.type,
            "messaging.message.id": resolved.id,
          },
        },
        async () => {
          await send([toRecord(resolved, codec)], [resolved.type]);
        },
      );
      metrics.publishDuration.record(now() - started, {
        type: resolved.type,
        transport: transport.name,
      });
      logger.debug("messaging.published", {
        type: resolved.type,
        id: resolved.id,
      });
    },

    async publishBatch(messages: readonly PublishMessage[]): Promise<void> {
      if (messages.length === 0) return;
      const resolved = messages.map(resolve);
      const records = resolved.map((m) => toRecord(m, codec));
      const started = now();
      await withSpan(
        telemetry?.tracer,
        "publish_batch",
        {
          kind: "producer",
          attributes: {
            "messaging.system": "forge",
            "messaging.batch.message_count": resolved.length,
          },
        },
        async () => {
          await send(
            records,
            resolved.map((m) => m.type),
          );
        },
      );
      // One histogram entry for the batch send (a batch may span types),
      // so the duration histogram stays consistent with single publishes.
      metrics.publishDuration.record(now() - started, {
        transport: transport.name,
        "batch.size": resolved.length,
      });
      logger.debug("messaging.published.batch", { count: messages.length });
    },

    async flush(): Promise<void> {
      // No-op: PR A transports are synchronous on `send`. Batching
      // transports will override this contract in a later PR.
    },

    async shutdown(): Promise<void> {
      await transport.shutdown?.();
    },
  };
}

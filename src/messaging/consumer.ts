/**
 * `createConsumer` — the consume side of `forge/messaging` (PR A).
 *
 * The consumer subscribes to a topic, decodes each delivery into a
 * {@link Message}, and invokes the user {@link MessageHandler}. On
 * success the delivery is acked; on failure (a thrown handler error or
 * a decode error) it is nacked, so the transport may redeliver
 * (at-least-once).
 *
 * Idempotent consumption (dedup store), bounded retry, and
 * dead-lettering are intentionally **not** here — they arrive in PR B.
 *
 * @module
 */

import { jsonCodec, type Codec } from "./codec";
import { HandlerError } from "./errors";
import { createMetrics, now, NOOP_LOGGER, withSpan } from "./observability";
import { toMessage } from "./protocol";
import type {
  ConsumeContext,
  ConsumerOptions,
  Logger,
  MessageConsumer,
  MessageHandler,
  MessagingTelemetry,
  Transport,
  TransportDelivery,
  TransportHandle,
} from "./types";

/**
 * Create a {@link MessageConsumer} over the given {@link Transport}.
 *
 * @example
 * ```ts
 * const consumer = createConsumer({
 *   transport,
 *   topic: "order.placed",
 *   handler: async (msg) => { await ship(msg.payload); },
 * });
 * await consumer.start();
 * ```
 */
export function createConsumer(options: ConsumerOptions): MessageConsumer {
  const transport: Transport = options.transport;
  const codec: Codec = options.codec ?? jsonCodec();
  const handler: MessageHandler = options.handler;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const telemetry: MessagingTelemetry | undefined = options.telemetry;
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const metrics = createMetrics(telemetry);

  const controller = new AbortController();
  const ctx: ConsumeContext = { signal: controller.signal, logger };

  let handle: TransportHandle | undefined;
  let started = false;

  const onMessage = async (delivery: TransportDelivery): Promise<void> => {
    const startedAt = now();
    let outcome: "ok" | "retry" = "ok";
    try {
      const message = toMessage(delivery, codec);
      await withSpan(
        telemetry?.tracer,
        `consume ${message.type}`,
        {
          kind: "consumer",
          attributes: {
            "messaging.system": "forge",
            "messaging.destination.name": message.type,
            "messaging.message.id": message.id,
            "messaging.message.attempt": message.attempt,
          },
        },
        async () => {
          await handler(message, ctx);
        },
      );
      await delivery.ack();
    } catch (cause) {
      outcome = "retry";
      const wrapped = new HandlerError(
        `Handler for "${delivery.record.type}" failed; message will be redelivered`,
        { cause, messageType: delivery.record.type },
      );
      logger.error("messaging.consume.failed", {
        topic: options.topic,
        type: delivery.record.type,
        id: delivery.record.id,
        attempt: delivery.attempt,
        error: wrapped.message,
      });
      await delivery.nack();
    } finally {
      metrics.consumed.add(1, { topic: options.topic, outcome });
      metrics.consumeDuration.record(now() - startedAt, {
        topic: options.topic,
        outcome,
      });
    }
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      handle = await transport.subscribe({
        topic: options.topic,
        concurrency,
        onMessage,
      });
      logger.info("messaging.consumer.started", {
        topic: options.topic,
        concurrency,
      });
    },

    async stop(): Promise<void> {
      if (!started) return;
      controller.abort();
      await handle?.stop();
      handle = undefined;
      started = false;
      logger.info("messaging.consumer.stopped", { topic: options.topic });
    },
  };
}

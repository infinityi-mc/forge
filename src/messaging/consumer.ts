/**
 * `createConsumer` — the consume side of `forge/messaging`.
 *
 * The consumer subscribes to a topic, decodes each delivery into a
 * {@link Message}, and runs it through a small pipeline:
 *
 * 1. **Dedup** — when an {@link InboxStore} is configured the message is
 *    claimed by its idempotency key; duplicates are skipped and
 *    in-flight claims are left for the transport to redeliver.
 * 2. **Retry** — the handler runs under an optional, structurally-typed
 *    {@link RetryPolicyLike} (a `forge/resilience` `retry(...)` or
 *    `combine(...)`), with a per-attempt {@link AbortSignal} that also
 *    trips when the consumer stops.
 * 3. **Dead-letter** — once retries are exhausted (or a body cannot be
 *    decoded) the message is parked in a {@link DeadLetterStore} and the
 *    delivery acked. With no DLQ the delivery is nacked for
 *    transport-level redelivery (PR A at-least-once behavior).
 *
 * Together an `inbox` + at-least-once delivery give *effective
 * exactly-once* consumption.
 *
 * @module
 */

import { jsonCodec, type Codec } from "./codec";
import { HandlerError, MessageDroppedError, SerializationError } from "./errors";
import { createMetrics, now, NOOP_LOGGER, withSpan } from "./observability";
import { envelopeOf, toMessage } from "./protocol";
import type {
  Clock,
  ConsumeContext,
  ConsumerOptions,
  DeadLetterEntry,
  DeadLetterStore,
  InboxStore,
  Logger,
  Message,
  MessageConsumer,
  MessageHandler,
  MessagingTelemetry,
  RetryExecutionContext,
  RetryPolicyLike,
  Transport,
  TransportDelivery,
  TransportHandle,
} from "./types";

type ConsumeOutcome = "ok" | "retry" | "dead";

/** A serialized snapshot of a failure, for dead-letter records and logs. */
function serializeError(error: unknown): DeadLetterEntry["error"] {
  if (error instanceof Error) {
    return error.stack !== undefined
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

/**
 * Create a {@link MessageConsumer} over the given {@link Transport}.
 *
 * @example
 * ```ts
 * import { retry, exponentialBackoff } from "forge/resilience";
 * import { inMemoryInboxStore } from "forge/messaging/inbox";
 * import { inMemoryDeadLetterStore } from "forge/messaging/deadletter";
 *
 * const consumer = createConsumer({
 *   transport,
 *   topic: "order.placed",
 *   inbox: inMemoryInboxStore(),
 *   retry: retry({ maxAttempts: 5, backoff: exponentialBackoff() }),
 *   deadLetter: inMemoryDeadLetterStore(),
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
  const topic = options.topic;

  const inbox: InboxStore | undefined = options.inbox;
  const deadLetter: DeadLetterStore | undefined = options.deadLetter;
  const retryPolicy: RetryPolicyLike | undefined = options.retry;
  const idempotencyKey = options.idempotencyKey ?? ((m: Message) => m.id);
  const clock: Clock = options.clock ?? { now: () => Date.now() };

  let controller = new AbortController();
  let handle: TransportHandle | undefined;
  let started = false;

  /**
   * Run the handler once, inside a consume span, with a signal that
   * combines the consumer-wide stop signal and the retry execution
   * signal (so a composed `timeout` aborts the in-flight handler).
   */
  const invokeHandler = (
    message: Message,
    execCtx: RetryExecutionContext,
  ): Promise<void> => {
    const signal = AbortSignal.any([controller.signal, execCtx.signal]);
    const ctx: ConsumeContext = { signal, logger };
    return withSpan(
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
  };

  /** Park a message in the DLQ (ack) or nack it for transport redelivery. */
  const dropOrRedeliver = async (
    delivery: TransportDelivery,
    message: Message,
    failure: unknown,
    attempts: number,
  ): Promise<ConsumeOutcome> => {
    if (deadLetter !== undefined) {
      await deadLetter.store({
        message,
        topic,
        error: serializeError(failure),
        attempts,
        failedAt: new Date(clock.now()),
      });
      metrics.deadLetterSize.add(1, { topic });
      const dropped = new MessageDroppedError(
        `Message "${message.id}" dead-lettered after ${attempts} attempt(s)`,
        { cause: failure, messageId: message.id, attempts },
      );
      logger.error("messaging.message.dropped", {
        topic,
        type: message.type,
        id: message.id,
        attempts,
        error: dropped.message,
      });
      await delivery.ack();
      return "dead";
    }

    const wrapped = new HandlerError(
      `Handler for "${message.type}" failed; message will be redelivered`,
      { cause: failure, messageType: message.type },
    );
    logger.error("messaging.consume.failed", {
      topic,
      type: message.type,
      id: message.id,
      attempt: message.attempt,
      error: wrapped.message,
    });
    await delivery.nack();
    return "retry";
  };

  const onMessage = async (delivery: TransportDelivery): Promise<void> => {
    const startedAt = now();

    // Decode first. A body that cannot be decoded is poison: it can
    // never succeed, so dead-letter it when a DLQ is configured rather
    // than redelivering forever.
    let message: Message;
    try {
      message = toMessage(delivery, codec);
    } catch (cause) {
      const outcome = await dropOrRedeliver(
        delivery,
        envelopeOf(delivery, undefined),
        new SerializationError(
          `Failed to decode message "${delivery.record.id}"`,
          { cause },
        ),
        0,
      );
      metrics.consumed.add(1, { topic, outcome });
      metrics.consumeDuration.record(now() - startedAt, { topic, outcome });
      return;
    }

    // Claim the message for idempotent consumption.
    const key = idempotencyKey(message);
    let claimed = false;
    if (inbox !== undefined) {
      const state = await inbox.begin(key);
      if (state === "duplicate") {
        metrics.deduped.add(1, { topic });
        logger.debug("messaging.inbox.deduped", { topic, id: message.id });
        await delivery.ack();
        return;
      }
      if (state === "in-flight") {
        // Another worker holds the claim; let the transport redeliver.
        await delivery.nack();
        return;
      }
      claimed = true;
    }

    let outcome: ConsumeOutcome = "ok";
    let attempts = 0;
    try {
      const runOnce = (execCtx: RetryExecutionContext): Promise<void> => {
        attempts += 1;
        return invokeHandler(message, execCtx);
      };
      const seedCtx: RetryExecutionContext = {
        signal: controller.signal,
        attempt: 1,
      };
      if (retryPolicy !== undefined) {
        await retryPolicy.execute(runOnce, seedCtx);
      } else {
        await runOnce(seedCtx);
      }
      if (claimed) await inbox!.commit(key);
      await delivery.ack();
    } catch (error) {
      // `retry` wraps the last handler failure on `cause`; unwrap one
      // level so the DLQ records the originating error, not the
      // RetryExhaustedError envelope.
      const failure = (error as { cause?: unknown }).cause ?? error;
      if (claimed) await inbox!.release(key);
      outcome = await dropOrRedeliver(delivery, message, failure, attempts);
    } finally {
      metrics.consumed.add(1, { topic, outcome });
      metrics.consumeDuration.record(now() - startedAt, { topic, outcome });
    }
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      // Claim the running slot synchronously so concurrent start() calls
      // can't double-subscribe; fresh signal per start so a stopped
      // consumer can be restarted.
      started = true;
      controller = new AbortController();
      try {
        handle = await transport.subscribe({
          topic: options.topic,
          concurrency,
          onMessage,
        });
      } catch (error) {
        // Subscribe failed: release the slot so start() can be retried
        // instead of leaving the consumer wedged (started but unsubscribed).
        started = false;
        throw error;
      }
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

/**
 * `inMemoryTransport` — an in-process {@link Transport} for tests and
 * single-process fan-out.
 *
 * Records published with `send` are routed to every subscription whose
 * topic matches the record's `type` (`"*"` catch-all, exact topic, or
 * trailing-`*` prefix wildcard). Each
 * subscription runs a bounded worker pool (its `concurrency`) that pulls
 * deliveries from an internal queue and invokes `onMessage`.
 *
 * Delivery is **at-least-once**: a `nack` (or a delivery the consumer
 * neither acked nor nacked) re-enqueues the record with an incremented
 * attempt, up to `maxDeliveries` — after which the record is dropped
 * with a warning so a poison message cannot spin forever. Bounded
 * retry and dead-lettering proper live in the consumer (PR B).
 *
 * @module
 */

import { NOOP_LOGGER } from "../../observability";
import { topicMatches } from "../../topic";
import type {
  Logger,
  Transport,
  TransportDelivery,
  TransportHandle,
  TransportRecord,
  TransportSubscription,
} from "../../types";

/** Options for {@link inMemoryTransport}. */
export interface InMemoryTransportOptions {
  /** Identifier reported as `transport.name`. Default `"memory"`. */
  readonly name?: string;
  /**
   * Max times a single record is delivered before it is dropped. Guards
   * against an always-nacking handler spinning forever. Default 16.
   */
  readonly maxDeliveries?: number;
  /** Opt-in logger for dropped-message warnings. */
  readonly logger?: Logger;
}

interface QueuedDelivery {
  readonly record: TransportRecord;
  readonly attempt: number;
}

interface Subscription {
  readonly topic: string;
  readonly concurrency: number;
  readonly onMessage: TransportSubscription["onMessage"];
  readonly queue: QueuedDelivery[];
  readonly waiters: Array<() => void>;
  closed: boolean;
  workers: Promise<void>[];
}

/** Create an in-process {@link Transport}. */
export function inMemoryTransport(
  options: InMemoryTransportOptions = {},
): Transport & { shutdown(): Promise<void> } {
  const name = options.name ?? "memory";
  const maxDeliveries = Math.max(1, options.maxDeliveries ?? 16);
  const logger = options.logger ?? NOOP_LOGGER;
  const subscriptions = new Set<Subscription>();
  let shuttingDown = false;

  const wake = (sub: Subscription): void => {
    const waiters = sub.waiters.splice(0, sub.waiters.length);
    for (const resolve of waiters) resolve();
  };

  const enqueue = (sub: Subscription, item: QueuedDelivery): void => {
    sub.queue.push(item);
    wake(sub);
  };

  const take = async (sub: Subscription): Promise<QueuedDelivery | undefined> => {
    while (sub.queue.length === 0 && !sub.closed) {
      await new Promise<void>((resolve) => sub.waiters.push(resolve));
    }
    if (sub.queue.length === 0) return undefined;
    return sub.queue.shift();
  };

  const runWorker = async (sub: Subscription): Promise<void> => {
    while (!sub.closed) {
      const item = await take(sub);
      if (item === undefined) return;

      let settled = false;
      const requeue = (): void => {
        const nextAttempt = item.attempt + 1;
        if (nextAttempt >= maxDeliveries) {
          logger.warn("messaging.memory.dropped", {
            transport: name,
            type: item.record.type,
            id: item.record.id,
            deliveries: nextAttempt,
          });
          return;
        }
        enqueue(sub, { record: item.record, attempt: nextAttempt });
      };

      const delivery: TransportDelivery = {
        record: item.record,
        attempt: item.attempt,
        ack(): void {
          settled = true;
        },
        nack(): void {
          if (settled) return;
          settled = true;
          requeue();
        },
      };

      try {
        await sub.onMessage(delivery);
        if (!settled) {
          // Treat a missing ack/nack as a nack (at-least-once).
          delivery.nack();
        }
      } catch {
        // The consumer wraps and logs handler errors; from the
        // transport's view an unhandled throw is a nack.
        if (!settled) delivery.nack();
      }
    }
  };

  return {
    name,

    async send(records: readonly TransportRecord[]): Promise<void> {
      for (const record of records) {
        for (const sub of subscriptions) {
          if (sub.closed) continue;
          if (!topicMatches(sub.topic, record.type)) continue;
          enqueue(sub, { record, attempt: 0 });
        }
      }
    },

    async subscribe(
      subscription: TransportSubscription,
    ): Promise<TransportHandle> {
      const sub: Subscription = {
        topic: subscription.topic,
        concurrency: Math.max(1, subscription.concurrency ?? 1),
        onMessage: subscription.onMessage,
        queue: [],
        waiters: [],
        closed: false,
        workers: [],
      };
      subscriptions.add(sub);
      for (let i = 0; i < sub.concurrency; i += 1) {
        sub.workers.push(runWorker(sub));
      }
      return {
        async stop(): Promise<void> {
          sub.closed = true;
          wake(sub);
          await Promise.all(sub.workers);
          subscriptions.delete(sub);
        },
      };
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      const subs = [...subscriptions];
      await Promise.all(
        subs.map(async (sub) => {
          sub.closed = true;
          wake(sub);
          await Promise.all(sub.workers);
        }),
      );
      subscriptions.clear();
    },
  };
}

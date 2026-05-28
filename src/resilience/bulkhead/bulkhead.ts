/**
 * `bulkhead` — concurrency limiter with a bounded wait queue.
 *
 * Isolates a slow or saturated dependency from the rest of the
 * application: if upstream is misbehaving, the bulkhead caps how many
 * in-flight calls can target it so the call site doesn't exhaust the
 * shared event loop / connection pool.
 *
 * State is per-instance: hold one bulkhead per dependency you want
 * isolated.
 *
 * @module
 */

import { buildInstruments } from "../telemetry/instrumentation";
import type {
  ExecutionContext,
  Operation,
} from "../types";
import { BulkheadFullError } from "./errors";
import { Semaphore } from "./semaphore";
import type { BulkheadOptions, BulkheadPolicy } from "./types";

/**
 * Create a bulkhead policy.
 *
 * @example
 * ```ts
 * import { bulkhead, combine } from "forge/resilience";
 *
 * const pipeline = combine(
 *   bulkhead({ maxConcurrent: 10, maxQueue: 50 }),
 * );
 * ```
 */
export function bulkhead(options: BulkheadOptions): BulkheadPolicy {
  const maxConcurrent = options.maxConcurrent;
  const maxQueue = options.maxQueue ?? 0;
  const semaphore = new Semaphore(maxConcurrent, maxQueue);
  const instruments = buildInstruments(options.telemetry);

  function reportQueue(): void {
    instruments
      .bulkheadQueueSize()
      ?.record(semaphore.state.queued, { policy: "bulkhead" });
  }

  async function execute<T>(
    op: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    if (ctx.signal.aborted) throw ctx.signal.reason;

    // Fast path: a slot is free right now.
    let release = semaphore.tryAcquire();
    if (!release) {
      if (semaphore.state.queued >= maxQueue) {
        const snapshot = semaphore.state;
        throw new BulkheadFullError(
          `bulkhead: no slots available (active=${snapshot.active}/${maxConcurrent}, queued=${snapshot.queued}/${maxQueue})`,
          {
            active: snapshot.active,
            maxConcurrent,
            queued: snapshot.queued,
            maxQueue,
          },
        );
      }
      // Slow path: queue and wait. Updates to the gauge bracket the
      // wait so observers see the queue grow and shrink.
      reportQueue();
      try {
        release = await semaphore.acquire(ctx.signal);
      } finally {
        reportQueue();
      }
    }

    instruments.attempts()?.add(1, { policy: "bulkhead" });

    try {
      return await op(ctx);
    } finally {
      release();
      reportQueue();
    }
  }

  return {
    name: "bulkhead",
    get active() {
      return semaphore.state.active;
    },
    get queued() {
      return semaphore.state.queued;
    },
    execute,
  };
}

/**
 * `createJobQueue` — enqueues background work onto a {@link JobStore}.
 *
 * @module
 */

import { createJobMetrics } from "../observability";
import type { Clock } from "../types";
import type {
  EnqueueOptions,
  EveryOptions,
  JobQueue,
  JobQueueOptions,
} from "./types";

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/**
 * Create a {@link JobQueue} over a {@link JobStore}.
 *
 * @example
 * ```ts
 * import { createJobQueue, sqliteJobStore } from "forge/messaging/jobs";
 *
 * const queue = createJobQueue({ store: sqliteJobStore() });
 * await queue.enqueue("email.send", { to: "a@b.c" });
 * await queue.every("report.daily", 86_400_000);
 * ```
 */
export function createJobQueue(options: JobQueueOptions): JobQueue {
  const store = options.store;
  const defaultMaxAttempts = Math.max(1, options.defaultMaxAttempts ?? 16);
  const clock: Clock = options.clock ?? SYSTEM_CLOCK;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  const metrics = createJobMetrics(options.telemetry);

  const enqueue = async <T>(
    name: string,
    payload: T | undefined,
    opts: EnqueueOptions & { intervalMs?: number; dedupKey?: string },
  ): Promise<string> => {
    const id = idGenerator();
    await store.enqueue({
      id,
      name,
      payload: payload ?? null,
      runAt: opts.runAt?.getTime() ?? clock.now(),
      maxAttempts: opts.maxAttempts ?? defaultMaxAttempts,
      intervalMs: opts.intervalMs ?? null,
      dedupKey: opts.dedupKey ?? null,
    });
    metrics.enqueued.add(1, { job: name });
    return id;
  };

  return {
    enqueue<T = unknown>(
      name: string,
      payload?: T,
      options?: EnqueueOptions,
    ): Promise<string> {
      return enqueue(name, payload, options ?? {});
    },

    schedule<T = unknown>(
      name: string,
      runAt: Date,
      payload?: T,
      options?: Omit<EnqueueOptions, "runAt">,
    ): Promise<string> {
      return enqueue(name, payload, { ...options, runAt });
    },

    every<T = unknown>(
      name: string,
      intervalMs: number,
      payload?: T,
      options?: EveryOptions,
    ): Promise<string> {
      const first = options?.delayFirst === true
        ? new Date(clock.now() + intervalMs)
        : new Date(clock.now());
      return enqueue(name, payload, {
        runAt: first,
        maxAttempts: options?.maxAttempts,
        intervalMs,
        dedupKey: options?.key ?? name,
      });
    },
  };
}

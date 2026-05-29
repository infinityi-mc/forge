/**
 * `createWorker` — claims jobs from a {@link JobStore} and runs the
 * matching {@link JobHandler}, retrying with backoff and dead-lettering
 * once a job's attempts are exhausted.
 *
 * The retry → dead-letter shape mirrors {@link createConsumer}: a
 * structural `retry(...)` policy wraps each in-process execution, while
 * the persistent attempt counter governs cross-claim redelivery. When
 * `attempt` reaches the job's `maxAttempts`, the job is parked in the
 * {@link DeadLetterStore} (if provided) and removed (or, for a recurring
 * job, advanced to its next occurrence).
 *
 * @module
 */

import { JobError } from "../errors";
import { NOOP_LOGGER, createJobMetrics } from "../observability";
import type {
  Clock,
  DeadLetterStore,
  Logger,
  Message,
  RetryPolicyLike,
} from "../types";
import type {
  ClaimedJobRecord,
  Job,
  JobHandler,
  JobStore,
  Worker,
  WorkerOptions,
} from "./types";

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/** Default backoff: capped exponential starting at 1s. */
function defaultBackoff(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 60_000);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Create a background-job {@link Worker} over a {@link JobStore}. */
export function createWorker(options: WorkerOptions): Worker {
  const store = options.store;
  const handlers = options.handlers ?? {};
  const fallback = options.handler;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const retryPolicy: RetryPolicyLike | undefined = options.retry;
  const deadLetter: DeadLetterStore | undefined = options.deadLetter;
  const visibilityMs = Math.max(1, options.visibilityMs ?? 30_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const backoff = options.backoff ?? defaultBackoff;
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const clock: Clock = options.clock ?? SYSTEM_CLOCK;
  const metrics = createJobMetrics(options.telemetry);

  let running = false;
  let stopped = false;
  let workers: Promise<void>[] = [];
  const waiters = new Set<() => void>();

  const resolveHandler = (name: string): JobHandler | undefined =>
    handlers[name] ?? fallback;

  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      waiters.add(resolve);
      setTimeout(() => {
        waiters.delete(resolve);
        resolve();
      }, pollIntervalMs);
    });

  const deadLetterJob = async (
    record: ClaimedJobRecord,
    error: Error,
  ): Promise<void> => {
    if (deadLetter === undefined) return;
    const message: Message = {
      id: record.id,
      type: record.name,
      payload: record.payload,
      headers: {},
      occurredAt: new Date(clock.now()),
      attempt: record.attempt,
    };
    await deadLetter.store({
      message,
      topic: record.name,
      error: { name: error.name, message: error.message, stack: error.stack },
      attempts: record.attempt,
      failedAt: new Date(clock.now()),
    });
  };

  const runJob = async (record: ClaimedJobRecord): Promise<void> => {
    const handler = resolveHandler(record.name);
    const job: Job = {
      id: record.id,
      name: record.name,
      payload: record.payload,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
    };

    if (handler === undefined) {
      const error = new JobError(`No handler registered for job "${record.name}"`, {
        jobId: record.id,
        jobName: record.name,
      });
      logger.error("messaging.jobs.no_handler", {
        job: record.name,
        id: record.id,
      });
      metrics.failed.add(1, { job: record.name });
      await deadLetterJob(record, error);
      await store.complete(record.id, clock.now());
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), visibilityMs);
    try {
      const exec = (attempt: number): Promise<void> =>
        Promise.resolve(handler(job, { signal: controller.signal, attempt }));
      if (retryPolicy !== undefined) {
        await retryPolicy.execute((ctx) => exec(ctx.attempt), {
          signal: controller.signal,
          attempt: 1,
        });
      } else {
        await exec(record.attempt);
      }
      metrics.completed.add(1, { job: record.name });
      await store.complete(record.id, clock.now());
    } catch (cause) {
      const error = toError(cause);
      if (record.attempt >= record.maxAttempts) {
        logger.error("messaging.jobs.exhausted", {
          job: record.name,
          id: record.id,
          attempts: record.attempt,
          error: error.message,
        });
        metrics.failed.add(1, { job: record.name });
        await deadLetterJob(record, error);
        await store.complete(record.id, clock.now());
      } else {
        logger.warn("messaging.jobs.retry", {
          job: record.name,
          id: record.id,
          attempt: record.attempt,
          error: error.message,
        });
        await store.retry(record.id, clock.now() + backoff(record.attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let record: ClaimedJobRecord | null = null;
      try {
        record = await store.claim(clock.now(), visibilityMs);
      } catch (error) {
        logger.error("messaging.jobs.claim_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (record === null) {
        if (stopped) return;
        await idle();
        continue;
      }
      await runJob(record);
    }
  };

  const wakeAll = (): void => {
    const current = [...waiters];
    waiters.clear();
    for (const resolve of current) resolve();
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      stopped = false;
      workers = Array.from({ length: concurrency }, () => loop());
    },

    async stop(): Promise<void> {
      if (!running) return;
      stopped = true;
      wakeAll();
      await Promise.all(workers);
      workers = [];
      running = false;
    },
  };
}

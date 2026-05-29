/**
 * Types for the background-jobs surface — a durable, scheduled work
 * queue layered on the same retry → dead-letter machinery as consumers.
 *
 * A {@link JobQueue} enqueues work (now, at a time, or on a recurring
 * interval); a {@link Worker} claims jobs from a {@link JobStore} and
 * runs the matching {@link JobHandler}, retrying with backoff and
 * dead-lettering once a job's attempts are exhausted.
 *
 * @module
 */

import type {
  Clock,
  DeadLetterStore,
  Logger,
  MessagingTelemetry,
  RetryPolicyLike,
} from "../types";

/** A unit of work handed to a {@link JobHandler}. */
export interface Job<T = unknown> {
  /** Stable job id (also the dedup key for recurring jobs). */
  readonly id: string;
  /** Job name; selects the {@link JobHandler} that runs it. */
  readonly name: string;
  /** The enqueued payload. */
  readonly payload: T;
  /** 1-based attempt counter; incremented on each (re)delivery. */
  readonly attempt: number;
  /** Max attempts before the job is dead-lettered. */
  readonly maxAttempts: number;
}

/** Per-execution context handed to a {@link JobHandler}. */
export interface JobContext {
  /** Aborted when the worker stops or the claim's visibility expires. */
  readonly signal: AbortSignal;
  /** 1-based attempt counter (mirrors {@link Job.attempt}). */
  readonly attempt: number;
}

/** Runs a single {@link Job}. Throwing schedules a retry / dead-letter. */
export type JobHandler<T = unknown> = (
  job: Job<T>,
  ctx: JobContext,
) => Promise<void> | void;

/** Options shared by enqueue / schedule. */
export interface EnqueueOptions {
  /** When the job first becomes runnable. Defaults to now. */
  readonly runAt?: Date;
  /** Max attempts before dead-lettering. Defaults to the queue's setting. */
  readonly maxAttempts?: number;
}

/** Options for a recurring {@link JobQueue.every} schedule. */
export interface EveryOptions {
  /**
   * Stable key the recurring schedule is upserted under, so repeated
   * `every(...)` calls keep exactly one schedule (single-flight).
   * Defaults to the job `name`.
   */
  readonly key?: string;
  /** Max attempts per occurrence before dead-lettering. */
  readonly maxAttempts?: number;
  /** Delay the first run by one interval instead of running immediately. */
  readonly delayFirst?: boolean;
}

/** Enqueues background work onto a {@link JobStore}. */
export interface JobQueue {
  /** Enqueue a job to run as soon as a worker claims it. */
  enqueue<T = unknown>(
    name: string,
    payload?: T,
    options?: EnqueueOptions,
  ): Promise<string>;
  /** Enqueue a job to run at or after `runAt`. */
  schedule<T = unknown>(
    name: string,
    runAt: Date,
    payload?: T,
    options?: Omit<EnqueueOptions, "runAt">,
  ): Promise<string>;
  /** Register a recurring job that re-schedules itself every `intervalMs`. */
  every<T = unknown>(
    name: string,
    intervalMs: number,
    payload?: T,
    options?: EveryOptions,
  ): Promise<string>;
}

/** Options for {@link createJobQueue}. */
export interface JobQueueOptions {
  /** Backing store (durable `sqliteJobStore` or `inMemoryJobStore`). */
  readonly store: JobStore;
  /** Default max attempts for enqueued jobs. Default 16. */
  readonly defaultMaxAttempts?: number;
  /** Opt-in metrics + traces. */
  readonly telemetry?: MessagingTelemetry;
  /** Injectable clock. Defaults to the system clock. */
  readonly clock?: Clock;
  /** Job id factory. Defaults to `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
}

/** A claimed-and-running worker. */
export interface Worker {
  /** Begin claiming and running jobs in the background. */
  start(): Promise<void>;
  /** Stop claiming and await in-flight jobs. */
  stop(): Promise<void>;
}

/** Options for {@link createWorker}. */
export interface WorkerOptions {
  /** Backing store; share the one the {@link JobQueue} writes to. */
  readonly store: JobStore;
  /** Per-name job handlers. */
  readonly handlers?: Readonly<Record<string, JobHandler>>;
  /** Fallback handler for names absent from {@link handlers}. */
  readonly handler?: JobHandler;
  /** Max jobs run concurrently. Default 1. */
  readonly concurrency?: number;
  /**
   * Bounded in-process retry around a single execution, consumed
   * structurally from `forge/resilience`. Independent of the persistent
   * attempt counter, which governs cross-claim redelivery.
   */
  readonly retry?: RetryPolicyLike;
  /** Where exhausted jobs are parked. */
  readonly deadLetter?: DeadLetterStore;
  /**
   * How long a claimed job stays invisible before another worker may
   * reclaim it (crash recovery). Default 30000ms.
   */
  readonly visibilityMs?: number;
  /** Idle poll interval when no job is runnable, in ms. Default 50. */
  readonly pollIntervalMs?: number;
  /** Backoff before a retryable failure becomes runnable again, in ms. */
  readonly backoff?: (attempt: number) => number;
  /** Opt-in metrics + traces. */
  readonly telemetry?: MessagingTelemetry;
  /** Opt-in structured logging. */
  readonly logger?: Logger;
  /** Injectable clock. Defaults to the system clock. */
  readonly clock?: Clock;
}

/** A job row as persisted by a {@link JobStore}. */
export interface NewJobRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  /** Epoch-ms timestamp the job first becomes runnable. */
  readonly runAt: number;
  readonly maxAttempts: number;
  /** Recurring interval in ms, or `null` for a one-shot job. */
  readonly intervalMs: number | null;
  /** Upsert key for recurring jobs, or `null`. */
  readonly dedupKey: string | null;
}

/** A job claimed for execution. */
export interface ClaimedJobRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  /** Attempt counter after the claim increment (1-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly intervalMs: number | null;
}

/**
 * Persistence contract for the job queue. The in-memory implementation
 * doubles as the test double; `sqliteJobStore` adds durability and
 * skip-locked claiming.
 */
export interface JobStore {
  /** Insert a job, upserting on `dedupKey` when set (recurring jobs). */
  enqueue(record: NewJobRecord): Promise<void>;
  /**
   * Atomically claim the next runnable job (`runAt <= now`, not locked),
   * locking it for `visibilityMs` and incrementing its attempt.
   */
  claim(now: number, visibilityMs: number): Promise<ClaimedJobRecord | null>;
  /**
   * Mark a claimed job done: a one-shot job is removed; a recurring job
   * is re-scheduled `intervalMs` into the future with a reset attempt.
   */
  complete(id: string, now: number): Promise<void>;
  /** Re-schedule a failed-but-retryable job to become runnable at `runAt`. */
  retry(id: string, runAt: number): Promise<void>;
  /** Count jobs currently in the store. */
  size(): Promise<number>;
  /** Release any owned resources. */
  close?(): Promise<void>;
}

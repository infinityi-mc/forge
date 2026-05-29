/**
 * Background-jobs entry point — `forge/messaging/jobs`.
 *
 * Re-exports {@link createJobQueue}, {@link createWorker}, the
 * {@link inMemoryJobStore} / {@link sqliteJobStore} backends, and the
 * job types.
 *
 * @module
 */

export { createJobQueue } from "./queue";
export { createWorker } from "./worker";
export { inMemoryJobStore } from "./memory-store";
export { sqliteJobStore } from "./sqlite-store";
export type { SqliteJobStoreOptions } from "./sqlite-store";
export type {
  ClaimedJobRecord,
  EnqueueOptions,
  EveryOptions,
  Job,
  JobContext,
  JobHandler,
  JobQueue,
  JobQueueOptions,
  JobStore,
  NewJobRecord,
  Worker,
  WorkerOptions,
} from "./types";

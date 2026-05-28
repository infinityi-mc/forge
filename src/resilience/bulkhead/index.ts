/**
 * `forge/resilience/bulkhead` — concurrency limiter with bounded wait
 * queue. Hold one per dependency.
 *
 * @module
 */

export { bulkhead } from "./bulkhead";
export { BulkheadFullError } from "./errors";
export type { BulkheadOptions, BulkheadPolicy } from "./types";

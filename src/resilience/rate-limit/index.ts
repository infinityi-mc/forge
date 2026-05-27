/**
 * `forge/resilience/rate-limit` — admit-or-wait policy with
 * token-bucket and sliding-window algorithms.
 *
 * @module
 */

export { rateLimit } from "./rate-limit";
export { RateLimitedError } from "./errors";
export type {
  RateLimitAlgorithm,
  RateLimitMode,
  RateLimitOptions,
  RateLimitPolicy,
} from "./types";

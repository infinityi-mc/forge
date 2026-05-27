/**
 * Timeout policy for `forge/resilience`.
 *
 * @example
 * ```ts
 * import { combine, timeout } from "forge/resilience";
 *
 * const pipeline = combine(timeout({ ms: 2_000 }));
 * await pipeline.execute(async (ctx) => {
 *   const res = await fetch(url, { signal: ctx.signal });
 *   return res.json();
 * });
 * ```
 *
 * @module
 */

export { timeout } from "./timeout";
export { TimeoutError } from "./errors";
export type { TimeoutOptions, TimeoutPolicy, TimeoutStrategy } from "./types";

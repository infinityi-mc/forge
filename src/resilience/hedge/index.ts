/**
 * `forge/resilience/hedge` — speculative parallel attempts with
 * automatic cancellation of losers.
 *
 * @module
 */

export { hedge } from "./hedge";
export { HedgeCancelledError } from "./errors";
export type { HedgeOptions, HedgePolicy } from "./types";

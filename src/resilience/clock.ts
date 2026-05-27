/**
 * Default {@link Clock} implementation backed by the host runtime.
 *
 * Policies that schedule work (retry backoffs, timeouts, rate-limit
 * waits) accept a `clock?: Clock` option so tests can substitute a
 * deterministic `TestClock` (`forge/resilience/testing`). Production
 * code uses {@link realClock}, which delegates to `Date.now` and
 * `setTimeout`.
 *
 * @module
 */

import type { Clock } from "./types";

/**
 * The default clock — `Date.now()` for the timestamp and `setTimeout`
 * for the sleep, with `AbortSignal`-driven cancellation.
 */
export const realClock: Clock = {
  now() {
    return Date.now();
  },
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (ms <= 0) {
      // Yield to the microtask queue so the contract ("returns a
      // Promise") is never violated by a synchronous resolution.
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

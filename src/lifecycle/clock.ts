/**
 * Default {@link Clock} implementation backed by the host runtime.
 *
 * Every bounded phase in `forge/lifecycle` (each `start`, each `stop`, the
 * pre-stop drain delay) is timed with a `Clock` so tests can substitute a
 * deterministic `TestClock` (`forge/lifecycle/testing`). Production uses
 * {@link realClock}, which delegates to `Date.now` and `setTimeout`.
 *
 * @module
 */

import type { Clock } from "./types";

/**
 * The default clock — `Date.now()` for the timestamp and `setTimeout` for the
 * sleep, with `AbortSignal`-driven cancellation so a pending timer never
 * outlives the work it bounds.
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

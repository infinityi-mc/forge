/**
 * `TestClock` — deterministic clock for tests.
 *
 * Replaces {@link realClock} in policies that schedule work so test
 * code can advance time instantly via `tickAsync(ms)` instead of
 * waiting for real `setTimeout`s. Pending sleeps that come due during
 * a tick are resolved (or rejected, when their abort signal fires)
 * before `tickAsync` returns, so assertions can run immediately
 * after.
 *
 * @example
 * ```ts
 * import { TestClock } from "forge/resilience/testing";
 * import { retry, exponentialBackoff } from "forge/resilience";
 *
 * const clock = new TestClock();
 * const policy = retry({
 *   maxAttempts: 3,
 *   backoff: exponentialBackoff({ initial: 100, jitter: false }),
 *   clock,
 * });
 *
 * const promise = policy.execute(failTwice, baseCtx);
 * await clock.tickAsync(100);  // first backoff fires
 * await clock.tickAsync(200);  // second backoff fires
 * await promise;
 * ```
 *
 * @module
 */

import type { Clock } from "../types";

interface PendingSleep {
  /** Wall-clock time the sleep is due. */
  due: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  /** Detach listener — called when the sleep settles either way. */
  detach: () => void;
}

/**
 * Deterministic clock used by tests. Holds an internal millisecond
 * counter and a list of pending sleeps; advancing the counter with
 * `tickAsync` releases any sleeps whose deadline is now reached.
 */
export class TestClock implements Clock {
  private current: number;
  private pending: PendingSleep[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (ms <= 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: PendingSleep = {
        due: this.current + ms,
        resolve,
        reject,
        detach: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };

      const onAbort = (): void => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        entry.detach();
        reject(signal!.reason);
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.push(entry);
    });
  }

  /**
   * Advance the clock by `ms` milliseconds, resolving any sleeps
   * whose deadline is now reached. Returns after the microtask queue
   * has drained so awaited continuations of resolved sleeps run
   * before `tickAsync` resolves — assertions immediately after the
   * `await` see the post-tick state.
   */
  async tickAsync(ms: number): Promise<void> {
    if (ms < 0) {
      throw new RangeError(`TestClock.tickAsync: ms must be >= 0, got ${ms}`);
    }
    this.current += ms;
    // Snapshot then drain — sleeps added during settlement get their
    // own due-time check on the next tick.
    const due = this.pending.filter((p) => p.due <= this.current);
    this.pending = this.pending.filter((p) => p.due > this.current);
    for (const entry of due) {
      entry.detach();
      entry.resolve();
    }
    // Yield once so awaiting continuations downstream of the
    // resolved sleeps can run before the caller continues.
    await flushMicrotasks();
  }

  /**
   * Number of sleeps currently pending. Useful in tests to assert
   * "the policy is currently in a backoff sleep".
   */
  get pendingCount(): number {
    return this.pending.length;
  }
}

/**
 * Drain the microtask queue. Used by {@link TestClock.tickAsync} to
 * make awaited continuations observable before returning.
 */
function flushMicrotasks(): Promise<void> {
  // Two `await Promise.resolve()` yields are enough for the common
  // case (resolve → `then` chain → user code). Loop a small number
  // of times to handle chains of awaits inside a settled sleep.
  return new Promise((resolve) => {
    let remaining = 4;
    const drain = (): void => {
      if (remaining-- <= 0) {
        resolve();
        return;
      }
      queueMicrotask(drain);
    };
    drain();
  });
}

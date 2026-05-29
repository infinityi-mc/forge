/**
 * `TestClock` — deterministic {@link Clock} for lifecycle tests.
 *
 * Replaces {@link realClock} so a test can advance time instantly via
 * `tickAsync(ms)` instead of waiting for real `setTimeout`s — essential for
 * exercising start/stop timeout slices without slow tests. Pending sleeps that
 * come due during a tick are settled (resolved, or rejected when their abort
 * signal fired) before `tickAsync` returns.
 *
 * @module
 */

import type { Clock } from "../types";

interface PendingSleep {
  due: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

/** Deterministic clock used by tests. */
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
   * Advance the clock by `ms`, settling any sleeps now due. Returns after the
   * microtask queue drains so awaited continuations run before `tickAsync`
   * resolves — assertions immediately after the `await` see post-tick state.
   */
  async tickAsync(ms: number): Promise<void> {
    if (ms < 0) {
      throw new RangeError(`TestClock.tickAsync: ms must be >= 0, got ${ms}`);
    }
    this.current += ms;
    const due = this.pending.filter((p) => p.due <= this.current);
    this.pending = this.pending.filter((p) => p.due > this.current);
    for (const entry of due) {
      entry.detach();
      entry.resolve();
    }
    await flushMicrotasks();
  }

  /** Number of sleeps currently pending. */
  get pendingCount(): number {
    return this.pending.length;
  }
}

function flushMicrotasks(): Promise<void> {
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

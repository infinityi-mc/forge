/**
 * Sliding-window rate-limit admission strategy.
 *
 * Tracks request timestamps; admission is granted iff the count of
 * timestamps within the last `windowMs` is below `limit`. Otherwise
 * returns the millisecond delay until the oldest timestamp ages out
 * of the window — exactly the moment a new request can be admitted.
 *
 * @module
 */

export interface SlidingWindowState {
  /** Wait `ms` before retrying. `0` means a slot was granted. */
  waitMs: number;
}

/**
 * Strict rolling-window limiter — admission decided by counting
 * timestamps within `windowMs`. Holds at most `limit` timestamps.
 */
export class SlidingWindowLimiter {
  private timestamps: number[] = [];
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Try to admit a single call at wall-clock `now`. Returns `0` when
   * admitted (and records the timestamp), or the milliseconds until
   * the oldest entry expires.
   */
  acquire(now: number): SlidingWindowState {
    this.evict(now);
    if (this.timestamps.length < this.limit) {
      this.timestamps.push(now);
      return { waitMs: 0 };
    }
    // Oldest entry's age plus delay-until-eviction.
    const oldest = this.timestamps[0]!;
    return { waitMs: Math.max(1, oldest + this.windowMs - now) };
  }

  /**
   * Try to record a slot used after waiting. Kept as a lower-level helper
   * for callers that pre-computed a wait; it still re-checks capacity so
   * concurrent waiters cannot over-admit when they wake at the same time.
   */
  commitWait(now: number): SlidingWindowState {
    return this.acquire(now);
  }

  /** Approximate number of admissions currently free. */
  available(now: number): number {
    this.evict(now);
    return Math.max(0, this.limit - this.timestamps.length);
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.timestamps.length && this.timestamps[drop]! <= cutoff) {
      drop++;
    }
    if (drop > 0) this.timestamps.splice(0, drop);
  }
}

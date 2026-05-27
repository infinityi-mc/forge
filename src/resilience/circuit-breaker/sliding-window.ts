/**
 * Sliding-window outcome trackers used by the circuit breaker.
 *
 * Two implementations satisfy the same {@link SlidingWindow} contract:
 *
 * - {@link CountWindow} keeps the last N outcomes — cheap, predictable,
 *   ideal for high-volume callers where N samples land quickly.
 * - {@link TimeWindow} keeps every outcome whose timestamp is within
 *   `durationMs` of "now". More accurate for bursty / low-volume
 *   callers where a count-window can hold stale failures indefinitely.
 *
 * Both expose `record(outcome, now)`, `clear()`, and counters for
 * `failures` / `samples`, which the breaker reads to decide whether to
 * trip. Implementations are pure data — they hold no timers, no
 * subscriptions, and no references to the parent breaker.
 *
 * @module
 */

export type Outcome = "success" | "failure";

/**
 * Outcome-tracker contract shared by count- and time-based windows.
 * Methods are synchronous and side-effect-free apart from updating the
 * window's own state.
 */
export interface SlidingWindow {
  /** Add a new outcome at wall-clock `now` (ms). */
  record(outcome: Outcome, now: number): void;
  /** Reset the window — drops every recorded sample. */
  clear(): void;
  /** Number of failures currently in the window. */
  failures(now: number): number;
  /** Number of samples currently in the window. */
  samples(now: number): number;
}

/**
 * Last-N-outcomes ring buffer. `size` is fixed at construction.
 */
export class CountWindow implements SlidingWindow {
  private readonly buffer: Outcome[];
  private cursor = 0;
  private filled = 0;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(
        `CountWindow: size must be an integer >= 1, got ${size}`,
      );
    }
    this.buffer = new Array<Outcome>(size);
  }

  record(outcome: Outcome, _now?: number): void {
    this.buffer[this.cursor] = outcome;
    this.cursor = (this.cursor + 1) % this.buffer.length;
    if (this.filled < this.buffer.length) this.filled++;
  }

  clear(): void {
    this.cursor = 0;
    this.filled = 0;
  }

  failures(_now?: number): number {
    let count = 0;
    for (let i = 0; i < this.filled; i++) {
      if (this.buffer[i] === "failure") count++;
    }
    return count;
  }

  samples(_now?: number): number {
    return this.filled;
  }
}

/**
 * Keeps outcomes whose timestamp is within `durationMs` of the
 * caller-supplied "now". Implemented as a FIFO of `(time, outcome)`
 * tuples; eviction happens lazily inside each accessor so the breaker
 * doesn't need a timer.
 */
export class TimeWindow implements SlidingWindow {
  private readonly durationMs: number;
  private entries: Array<{ time: number; outcome: Outcome }> = [];

  constructor(durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError(
        `TimeWindow: durationMs must be a positive finite number, got ${durationMs}`,
      );
    }
    this.durationMs = durationMs;
  }

  record(outcome: Outcome, now: number): void {
    this.evict(now);
    this.entries.push({ time: now, outcome });
  }

  clear(): void {
    this.entries = [];
  }

  failures(now: number): number {
    this.evict(now);
    let count = 0;
    for (const entry of this.entries) {
      if (entry.outcome === "failure") count++;
    }
    return count;
  }

  samples(now: number): number {
    this.evict(now);
    return this.entries.length;
  }

  private evict(now: number): void {
    const cutoff = now - this.durationMs;
    // Linear scan from the front — entries are appended in order, so
    // this is O(k) for k evicted entries and amortizes to O(1).
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop]!.time <= cutoff) {
      drop++;
    }
    if (drop > 0) this.entries.splice(0, drop);
  }
}

/**
 * Asynchronous semaphore with a bounded wait queue.
 *
 * Used by {@link bulkhead} to limit concurrency while still letting a
 * configurable number of callers queue for the next free slot.
 * Implementation choices:
 *
 * - `acquire(signal?)` returns a `release()` function once a slot is
 *   granted. The caller must `release()` to free the slot — typically
 *   in `try`/`finally`.
 * - The wait queue is FIFO and bounded. `tryAcquire` returns
 *   `undefined` when both the slot pool and the queue are full.
 * - `AbortSignal` integration: if `signal` aborts while the caller is
 *   queued, the queue entry is removed and `acquire` rejects with
 *   the signal's reason — no leaked queue slot.
 *
 * @module
 */

interface Waiter {
  resolve(release: () => void): void;
  reject(reason: unknown): void;
  /** Detach any AbortSignal listener associated with the waiter. */
  detach(): void;
}

export interface SemaphoreState {
  /** Slots currently in use. */
  readonly active: number;
  /** Callers currently parked in the queue. */
  readonly queued: number;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  readonly maxConcurrent: number;
  readonly maxQueue: number;

  constructor(maxConcurrent: number, maxQueue: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(
        `Semaphore: maxConcurrent must be an integer >= 1, got ${maxConcurrent}`,
      );
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError(
        `Semaphore: maxQueue must be an integer >= 0, got ${maxQueue}`,
      );
    }
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
  }

  get state(): SemaphoreState {
    return { active: this.active, queued: this.waiters.length };
  }

  /**
   * Take a slot if one is immediately free; otherwise return `undefined`.
   * `undefined` lets the caller decide whether to fall back to
   * `acquire` (queue) or fail fast.
   */
  tryAcquire(): (() => void) | undefined {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.makeRelease();
    }
    return undefined;
  }

  /**
   * Queue for a slot, waiting until one becomes free. Returns a
   * release function that the caller must invoke when done.
   *
   * Rejects with the signal's reason if `signal` aborts before a slot
   * is granted; the waiter is then removed from the queue.
   *
   * Throws synchronously when the queue is already at `maxQueue`.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(
        new Error("Semaphore: queue is full"),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };

      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        waiter.detach();
        reject(signal!.reason);
      };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot directly to the next waiter — `active` stays
        // unchanged because we're transferring, not freeing.
        next.detach();
        next.resolve(this.makeRelease());
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}

/**
 * Token-bucket rate-limit admission strategy.
 *
 * Holds up to `burst` tokens and refills at `tokensPerSecond`. Calls
 * to {@link acquire} return a non-negative wait time: `0` means a
 * token is immediately available; a positive number is the
 * millisecond delay until the next token will be ready. The limiter
 * is responsible for actually sleeping — the strategy is pure
 * arithmetic so it stays trivial to unit-test.
 *
 * @module
 */

export interface TokenBucketState {
  /** Wait `ms` before retrying. `0` means a token was granted. */
  waitMs: number;
}

/**
 * Internal state for a token bucket. Exposed for the `availableTokens`
 * accessor on the policy.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  readonly burst: number;
  readonly tokensPerSecond: number;

  constructor(tokensPerSecond: number, burst: number, now: number) {
    this.tokensPerSecond = tokensPerSecond;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefill = now;
  }

  /**
   * Refill the bucket based on the elapsed time since the previous
   * refill, then attempt to take a single token. Returns `0` when a
   * token was granted, or the milliseconds to wait until the next
   * token will be available.
   */
  acquire(now: number): TokenBucketState {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { waitMs: 0 };
    }
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil((deficit / this.tokensPerSecond) * 1_000);
    return { waitMs };
  }

  /**
   * Try to debit one token after a previously scheduled wait. Kept as a
   * lower-level helper for callers that pre-computed a wait; it still
   * re-checks capacity so concurrent waiters cannot over-admit when they
   * wake at the same time.
   */
  commitWait(now: number): TokenBucketState {
    return this.acquire(now);
  }

  /** Approximate number of currently available tokens (floored). */
  available(now: number): number {
    this.refill(now);
    return Math.max(0, Math.floor(this.tokens));
  }

  private refill(now: number): void {
    const delta = Math.max(0, now - this.lastRefill);
    if (delta === 0) return;
    const refill = (delta / 1_000) * this.tokensPerSecond;
    this.tokens = Math.min(this.burst, this.tokens + refill);
    this.lastRefill = now;
  }
}

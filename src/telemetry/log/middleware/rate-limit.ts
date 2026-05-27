/**
 * Local token-bucket rate limiting for log records.
 *
 * @module
 */

import { LogRateLimitError } from "../errors";
import type { LogMiddleware } from "../types";
import { notifyDrop } from "./hooks";

export type LogRateLimitWhenExceeded = "drop" | "throw";

export interface LogRateLimitOptions {
  /** Records allowed per `intervalMs`. Must be > 0. */
  recordsPerInterval: number;
  /** Refill interval in milliseconds. Defaults to `1_000`. */
  intervalMs?: number;
  /** Burst size (max accumulated tokens). Defaults to `recordsPerInterval`. */
  burst?: number;
  /** Action when the bucket is empty. Defaults to `"drop"`. */
  whenExceeded?: LogRateLimitWhenExceeded;
  /** Override the clock source for tests. */
  now?: () => number;
}

export function rateLimit(options: LogRateLimitOptions): LogMiddleware {
  if (options.recordsPerInterval <= 0) {
    throw new Error("rateLimit: recordsPerInterval must be > 0");
  }
  const intervalMs = options.intervalMs ?? 1_000;
  if (intervalMs <= 0) throw new Error("rateLimit: intervalMs must be > 0");
  const burst = options.burst ?? options.recordsPerInterval;
  if (burst <= 0) throw new Error("rateLimit: burst must be > 0");
  const whenExceeded = options.whenExceeded ?? "drop";
  const now = options.now ?? Date.now;
  const ratePerMs = options.recordsPerInterval / intervalMs;

  return (next) => {
    let tokens = burst;
    let lastRefillAt = now();

    function refill(): void {
      const t = now();
      const elapsed = t - lastRefillAt;
      if (elapsed <= 0) return;
      tokens = Math.min(burst, tokens + elapsed * ratePerMs);
      lastRefillAt = t;
    }

    return {
      export(record) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          next.export(record);
          return;
        }
        const retryAfterMs = Math.ceil((1 - tokens) / ratePerMs);
        if (whenExceeded === "throw") {
          throw new LogRateLimitError("log rate limit exceeded", {
            retryAfterMs,
          });
        }
        notifyDrop(next, {
          record,
          reason: "rate-limit",
          middleware: "rateLimit",
          metadata: { retryAfterMs },
        });
      },
    };
  };
}

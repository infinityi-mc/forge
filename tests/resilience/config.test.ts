import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../src/config/define";
import { envSource } from "../../src/config/sources/env";
import { bulkhead } from "../../src/resilience/bulkhead";
import { circuitBreaker } from "../../src/resilience/circuit-breaker";
import { fallback } from "../../src/resilience/fallback";
import { hedge } from "../../src/resilience/hedge";
import { rateLimit } from "../../src/resilience/rate-limit";
import { retry } from "../../src/resilience/retry";
import { timeout } from "../../src/resilience/timeout";
import {
  bulkheadOptionsFromConfig,
  circuitBreakerOptionsFromConfig,
  fallbackOptionsFromConfig,
  hedgeOptionsFromConfig,
  rateLimitOptionsFromConfig,
  resilienceConfigSchema,
  retryOptionsFromConfig,
  timeoutOptionsFromConfig,
} from "../../src/resilience/config";

function load(env: Record<string, string | undefined> = {}) {
  return defineConfig(
    { resilience: resilienceConfigSchema },
    { sources: [envSource({ env })], throwOnError: true },
  ).resilience;
}

describe("resilience config helpers", () => {
  test("loads documented defaults", () => {
    const config = load();

    expect(config.retry.maxAttempts).toBe(3);
    expect(config.retry.backoffInitialMs).toBe(100);
    expect(config.retry.backoffMaxMs).toBe(2_000);
    expect(config.retry.jitter).toBe(true);
    expect(config.timeout).toEqual({ ms: 2_000, strategy: "optimistic" });
    expect(config.circuitBreaker.failureThreshold).toBe(0.5);
    expect(config.circuitBreaker.resetTimeoutMs).toBe(30_000);
    expect(config.rateLimit.algorithm.kind).toBe("token-bucket");
    expect(config.bulkhead).toEqual({ maxConcurrent: 10, maxQueue: 0 });
    expect(config.fallback.enabled).toBe(false);
    expect(config.hedge).toEqual({ delay: 50, maxHedgedAttempts: 2 });
  });

  test("loads env overrides with nested resilience paths", () => {
    const config = load({
      RESILIENCE_RETRY_MAX_ATTEMPTS: "5",
      RESILIENCE_RETRY_BACKOFF_INITIAL_MS: "25",
      RESILIENCE_RETRY_BACKOFF_MAX_MS: "250",
      RESILIENCE_RETRY_JITTER: "false",
      RESILIENCE_TIMEOUT_MS: "750",
      RESILIENCE_TIMEOUT_STRATEGY: "pessimistic",
      RESILIENCE_CIRCUIT_BREAKER_FAILURE_THRESHOLD: "3",
      RESILIENCE_CIRCUIT_BREAKER_HALF_OPEN_MAX_ATTEMPTS: "2",
      RESILIENCE_CIRCUIT_BREAKER_SLOW_CALL_DURATION_MS: "500",
      RESILIENCE_CIRCUIT_BREAKER_SLOW_CALL_THRESHOLD: "0.75",
      RESILIENCE_RATE_LIMIT_MODE: "wait",
      RESILIENCE_RATE_LIMIT_MAX_WAITERS: "7",
      RESILIENCE_RATE_LIMIT_ALGORITHM_KIND: "sliding-window",
      RESILIENCE_RATE_LIMIT_ALGORITHM_LIMIT: "12",
      RESILIENCE_RATE_LIMIT_ALGORITHM_WINDOW_MS: "1000",
      RESILIENCE_BULKHEAD_MAX_CONCURRENT: "4",
      RESILIENCE_BULKHEAD_MAX_QUEUE: "8",
      RESILIENCE_FALLBACK_ENABLED: "true",
      RESILIENCE_HEDGE_DELAY: "30",
      RESILIENCE_HEDGE_MAX_HEDGED_ATTEMPTS: "3",
    });

    expect(config.retry).toMatchObject({
      maxAttempts: 5,
      backoffInitialMs: 25,
      backoffMaxMs: 250,
      jitter: false,
    });
    expect(config.timeout).toEqual({ ms: 750, strategy: "pessimistic" });
    expect(config.circuitBreaker).toMatchObject({
      failureThreshold: 3,
      halfOpenMaxAttempts: 2,
      slowCallDurationMs: 500,
      slowCallThreshold: 0.75,
    });
    expect(config.rateLimit.mode).toBe("wait");
    expect(config.rateLimit.maxWaiters).toBe(7);
    expect(config.rateLimit.algorithm).toMatchObject({
      kind: "sliding-window",
      limit: 12,
      windowMs: 1_000,
    });
    expect(config.bulkhead).toEqual({ maxConcurrent: 4, maxQueue: 8 });
    expect(config.fallback.enabled).toBe(true);
    expect(config.hedge).toEqual({ delay: 30, maxHedgedAttempts: 3 });
  });

  test("maps config into options accepted by resilience constructors", () => {
    const config = load({
      RESILIENCE_RETRY_JITTER: "false",
      RESILIENCE_RATE_LIMIT_ALGORITHM_BURST: "20",
      RESILIENCE_FALLBACK_ENABLED: "true",
    });

    expect(retry(retryOptionsFromConfig(config.retry)).maxAttempts).toBe(3);
    expect(retryOptionsFromConfig(config.retry).backoff?.delay(2)).toBe(200);
    expect(timeout(timeoutOptionsFromConfig(config.timeout)).ms).toBe(2_000);
    expect(circuitBreaker(circuitBreakerOptionsFromConfig(config.circuitBreaker)).state).toBe("closed");
    expect(rateLimit(rateLimitOptionsFromConfig(config.rateLimit)).availableTokens).toBe(20);
    expect(bulkhead(bulkheadOptionsFromConfig(config.bulkhead)).active).toBe(0);
    expect(hedge(hedgeOptionsFromConfig(config.hedge)).name).toBe("hedge");

    const fallbackOptions = fallbackOptionsFromConfig(config.fallback, {
      fallback: () => "stale",
    });
    expect(fallbackOptions).toBeDefined();
    expect(fallback(fallbackOptions!).name).toBe("fallback");
  });

  test("fallback mapper omits policy options when disabled", () => {
    const config = load();
    const options = fallbackOptionsFromConfig(config.fallback, {
      fallback: () => "stale",
    });

    expect(options).toBeUndefined();
  });

  test("constructor validation remains the source of range errors", () => {
    const config = load({ RESILIENCE_TIMEOUT_MS: "-1" });
    const options = timeoutOptionsFromConfig(config.timeout);

    expect(() => timeout(options)).toThrow(RangeError);
  });
});

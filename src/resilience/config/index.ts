/**
 * `forge/resilience/config` — opt-in schema fragments and pure mappers for
 * resilience policies.
 *
 * The helpers deliberately do not call `defineConfig`; applications keep
 * control over their source stack, fail-fast behavior, and deployment-specific
 * overrides. Policy constructors remain the source of runtime range validation.
 *
 * @module
 */

import { t } from "../../config/schema/builder";
import type { Infer } from "../../config/types";
import type { BulkheadOptions } from "../bulkhead";
import type { CircuitBreakerOptions } from "../circuit-breaker";
import type { FallbackHandler, FallbackOptions, FallbackPredicate } from "../fallback";
import type { HedgeOptions } from "../hedge";
import type { RateLimitOptions } from "../rate-limit";
import { exponentialBackoff } from "../retry";
import type { RetryOptions } from "../retry";
import type { TimeoutOptions } from "../timeout";

/** Schema fragments suitable for nesting under an application config schema. */
export const resilienceConfigSchema = {
  retry: {
    maxAttempts: t.number.int.default(3),
    backoffInitialMs: t.number.default(100),
    backoffMaxMs: t.number.default(2_000),
    jitter: t.boolean.default(true),
  },
  timeout: {
    ms: t.number.default(2_000),
    strategy: t.enum(["optimistic", "pessimistic"] as const).default("optimistic"),
  },
  circuitBreaker: {
    failureThreshold: t.number.default(0.5),
    minimumRequests: t.number.int.default(10),
    resetTimeoutMs: t.number.default(30_000),
    halfOpenMaxAttempts: t.number.int.optional(),
    slowCallDurationMs: t.number.optional(),
    slowCallThreshold: t.number.optional(),
  },
  rateLimit: {
    mode: t.enum(["throw", "wait"] as const).default("throw"),
    maxWaiters: t.number.int.optional(),
    algorithm: {
      kind: t.enum(["token-bucket", "sliding-window"] as const).default("token-bucket"),
      tokensPerSecond: t.number.default(10),
      burst: t.number.optional(),
      limit: t.number.int.default(10),
      windowMs: t.number.default(1_000),
    },
  },
  bulkhead: {
    maxConcurrent: t.number.int.default(10),
    maxQueue: t.number.int.default(0),
  },
  fallback: {
    enabled: t.boolean.default(false),
  },
  hedge: {
    delay: t.number.default(50),
    maxHedgedAttempts: t.number.int.default(2),
  },
} as const;

export type ResilienceConfig = Infer<typeof resilienceConfigSchema>;
export type ResilienceRetryConfig = ResilienceConfig["retry"];
export type ResilienceTimeoutConfig = ResilienceConfig["timeout"];
export type ResilienceCircuitBreakerConfig = ResilienceConfig["circuitBreaker"];
export type ResilienceRateLimitConfig = ResilienceConfig["rateLimit"];
export type ResilienceBulkheadConfig = ResilienceConfig["bulkhead"];
export type ResilienceFallbackConfig = ResilienceConfig["fallback"];
export type ResilienceHedgeConfig = ResilienceConfig["hedge"];

export interface FallbackOptionsFromConfigOptions {
  readonly fallback: FallbackHandler;
  readonly shouldFallback?: FallbackPredicate;
}

/** Map retry config into options accepted by {@link retry}. */
export function retryOptionsFromConfig(config: ResilienceRetryConfig): RetryOptions {
  return {
    maxAttempts: config.maxAttempts,
    backoff: exponentialBackoff({
      initial: config.backoffInitialMs,
      max: config.backoffMaxMs,
      jitter: config.jitter,
    }),
  };
}

/** Map timeout config into options accepted by {@link timeout}. */
export function timeoutOptionsFromConfig(config: ResilienceTimeoutConfig): TimeoutOptions {
  return {
    ms: config.ms,
    strategy: config.strategy,
  };
}

/** Map circuit-breaker config into options accepted by {@link circuitBreaker}. */
export function circuitBreakerOptionsFromConfig(
  config: ResilienceCircuitBreakerConfig,
): CircuitBreakerOptions {
  return {
    failureThreshold: config.failureThreshold,
    minimumRequests: config.minimumRequests,
    resetTimeoutMs: config.resetTimeoutMs,
    ...(config.halfOpenMaxAttempts === undefined
      ? {}
      : { halfOpenMaxAttempts: config.halfOpenMaxAttempts }),
    ...(config.slowCallDurationMs === undefined
      ? {}
      : { slowCallDurationMs: config.slowCallDurationMs }),
    ...(config.slowCallThreshold === undefined
      ? {}
      : { slowCallThreshold: config.slowCallThreshold }),
  };
}

/** Map rate-limit config into options accepted by {@link rateLimit}. */
export function rateLimitOptionsFromConfig(config: ResilienceRateLimitConfig): RateLimitOptions {
  const algorithm: RateLimitOptions["algorithm"] =
    config.algorithm.kind === "sliding-window"
      ? {
          kind: "sliding-window",
          limit: config.algorithm.limit,
          windowMs: config.algorithm.windowMs,
        }
      : {
          kind: "token-bucket",
          tokensPerSecond: config.algorithm.tokensPerSecond,
          ...(config.algorithm.burst === undefined ? {} : { burst: config.algorithm.burst }),
        };

  return {
    algorithm,
    mode: config.mode,
    ...(config.maxWaiters === undefined ? {} : { maxWaiters: config.maxWaiters }),
  };
}

/** Map bulkhead config into options accepted by {@link bulkhead}. */
export function bulkheadOptionsFromConfig(config: ResilienceBulkheadConfig): BulkheadOptions {
  return {
    maxConcurrent: config.maxConcurrent,
    maxQueue: config.maxQueue,
  };
}

/** Map hedge config into options accepted by {@link hedge}. */
export function hedgeOptionsFromConfig(config: ResilienceHedgeConfig): HedgeOptions {
  return {
    delay: config.delay,
    maxHedgedAttempts: config.maxHedgedAttempts,
  };
}

/**
 * Build fallback options only when the config toggle is enabled. The fallback
 * handler remains an explicit runtime dependency, not a serializable config value.
 */
export function fallbackOptionsFromConfig(
  config: ResilienceFallbackConfig,
  options: FallbackOptionsFromConfigOptions,
): FallbackOptions | undefined {
  if (!config.enabled) return undefined;
  return {
    fallback: options.fallback,
    ...(options.shouldFallback === undefined ? {} : { shouldFallback: options.shouldFallback }),
  };
}

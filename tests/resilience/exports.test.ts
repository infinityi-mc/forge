import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as resilience from "../../src/resilience";
import * as bulkhead from "../../src/resilience/bulkhead";
import * as circuitBreaker from "../../src/resilience/circuit-breaker";
import * as config from "../../src/resilience/config";
import * as errors from "../../src/resilience/errors";
import * as fallback from "../../src/resilience/fallback";
import * as hedge from "../../src/resilience/hedge";
import * as messaging from "../../src/resilience/messaging";
import * as rateLimit from "../../src/resilience/rate-limit";
import * as retry from "../../src/resilience/retry";
import * as testing from "../../src/resilience/testing";
import * as timeout from "../../src/resilience/timeout";

describe("resilience exports", () => {
  test("root resilience surface exposes core policies and errors", () => {
    expect(resilience.combine).toBeFunction();
    expect(resilience.retry).toBeFunction();
    expect(resilience.timeout).toBeFunction();
    expect(resilience.circuitBreaker).toBeFunction();
    expect(resilience.rateLimit).toBeFunction();
    expect(resilience.bulkhead).toBeFunction();
    expect(resilience.fallback).toBeFunction();
    expect(resilience.hedge).toBeFunction();
    expect(resilience.ResilienceError).toBeFunction();
    expect(resilience.RateLimitError).toBeFunction();
  });

  test("package root intentionally re-exports resilience", () => {
    expect(root.combine).toBe(resilience.combine);
    expect(root.retry).toBe(resilience.retry);
    expect(root.timeout).toBe(resilience.timeout);
  });

  test("retry and timeout subpath entrypoints are populated", () => {
    expect(retry.retry).toBeFunction();
    expect(retry.exponentialBackoff).toBeFunction();
    expect(retry.linearBackoff).toBeFunction();
    expect(retry.constantBackoff).toBeFunction();
    expect(retry.RetryExhaustedError).toBeFunction();
    expect(timeout.timeout).toBeFunction();
    expect(timeout.TimeoutError).toBeFunction();
  });

  test("policy subpath entrypoints expose their public surfaces", () => {
    expect(circuitBreaker.circuitBreaker).toBeFunction();
    expect(circuitBreaker.CircuitOpenError).toBeFunction();
    expect(rateLimit.rateLimit).toBeFunction();
    expect(rateLimit.RateLimitedError).toBeFunction();
    expect(bulkhead.bulkhead).toBeFunction();
    expect(bulkhead.BulkheadFullError).toBeFunction();
    expect(fallback.fallback).toBeFunction();
    expect(hedge.hedge).toBeFunction();
    expect(hedge.HedgeCancelledError).toBeFunction();
  });

  test("errors and testing subpaths expose support surfaces", () => {
    expect(errors.ResilienceError).toBeFunction();
    expect(errors.TransientError).toBeFunction();
    expect(errors.RateLimitError).toBeFunction();
    expect(testing.TestClock).toBeFunction();
    expect(testing.createTestResilience).toBeFunction();
    expect(testing.createTestResilienceTelemetry).toBeFunction();
    expect(testing.assertConformance).toBeFunction();
    expect(testing.assertPolicyConformance).toBeFunction();
    expect(testing.STANDARD_RESILIENCE_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.POLICY_SPECIFIC_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.BULKHEAD_RESILIENCE_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.FALLBACK_RESILIENCE_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.RATE_LIMIT_RESILIENCE_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.COMPOSITION_RESILIENCE_SCENARIOS.length).toBeGreaterThan(0);
    expect(testing.CLOCK_DETERMINISM_SCENARIOS.length).toBeGreaterThan(0);
  });

  test("optional integration subpaths expose scoped helpers", () => {
    expect(config.resilienceConfigSchema.retry).toBeDefined();
    expect(config.retryOptionsFromConfig).toBeFunction();
    expect(config.timeoutOptionsFromConfig).toBeFunction();
    expect(config.circuitBreakerOptionsFromConfig).toBeFunction();
    expect(config.rateLimitOptionsFromConfig).toBeFunction();
    expect(config.bulkheadOptionsFromConfig).toBeFunction();
    expect(config.fallbackOptionsFromConfig).toBeFunction();
    expect(config.hedgeOptionsFromConfig).toBeFunction();
    expect(messaging.DEFAULT_CIRCUIT_BREAKER_STATE_MESSAGE_TYPE).toBe(
      "forge.resilience.circuit.state_changed",
    );
    expect(messaging.circuitBreakerStatePublisher).toBeFunction();
  });
});

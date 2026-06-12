/**
 * `forge/resilience` adapters — expose circuit breakers and bulkheads as
 * lifecycle health components.
 *
 * These adapters are readiness checks. They do not start, stop, reset, or
 * otherwise mutate policy state.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component, HealthResult } from "../types";
import type {
  BulkheadComponentOptions,
  BulkheadLike,
  CircuitBreakerComponentOptions,
  CircuitBreakerLike,
} from "./types";

/**
 * Adapt a circuit breaker into a health-only {@link Component}:
 * - `closed` -> `healthy`;
 * - `half-open` -> `degraded`;
 * - `open` -> `unhealthy` by default, or `degraded` with `degraded: true`.
 */
export function circuitBreakerComponent(
  name: string,
  breaker: CircuitBreakerLike,
  options: CircuitBreakerComponentOptions = {},
): Component {
  const healthcheck =
    options.healthcheck ??
    ((): HealthResult => {
      if (breaker.state === "closed") {
        return { status: "healthy", data: { state: breaker.state } };
      }
      if (breaker.state === "half-open" || options.degraded === true) {
        return {
          status: "degraded",
          detail: `circuit breaker is ${breaker.state}`,
          data: { state: breaker.state },
        };
      }
      return {
        status: "unhealthy",
        detail: "circuit breaker is open",
        data: { state: breaker.state },
      };
    });

  return asComponent(name, { healthcheck });
}

/**
 * Adapt a bulkhead into a health-only {@link Component}. A queued caller means
 * the dependency is saturated, so readiness is `degraded` by default and can be
 * escalated to `unhealthy` with `unhealthyAtSaturation: true`.
 */
export function bulkheadComponent(
  name: string,
  bulkhead: BulkheadLike,
  options: BulkheadComponentOptions = {},
): Component {
  const healthcheck =
    options.healthcheck ??
    ((): HealthResult => {
      const saturated = bulkhead.queued > 0;
      let status: HealthResult["status"] = "healthy";
      if (saturated) {
        status = options.unhealthyAtSaturation === true ? "unhealthy" : "degraded";
      }
      return {
        status,
        data: { active: bulkhead.active, queued: bulkhead.queued },
      };
    });

  return asComponent(name, { healthcheck });
}

/**
 * `forge/resilience/circuit-breaker` — three-state breaker that fails
 * fast when a dependency is unhealthy. Explicitly instantiated; no
 * global registry.
 *
 * @module
 */

export { circuitBreaker } from "./breaker";
export { CircuitOpenError } from "./errors";
export type {
  CircuitBreakerOptions,
  CircuitBreakerPolicy,
  CircuitState,
  CircuitWindow,
} from "./types";

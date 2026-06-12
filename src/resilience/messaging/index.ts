/**
 * `forge/resilience/messaging` — structural bridge from circuit-breaker
 * state-change events to any message bus with a `publish` method.
 *
 * Publishing is best-effort and observational: failures are routed to the
 * optional `onError` hook and never affect circuit-breaker state transitions.
 *
 * @module
 */

import type { CircuitStateChangeEvent } from "../circuit-breaker";

export interface MessageBusLike {
  publish<T>(message: {
    readonly type: string;
    readonly payload: T;
    readonly headers?: Record<string, string>;
    readonly occurredAt?: Date;
  }): Promise<void>;
}

export interface CircuitBreakerStatePublisherOptions {
  readonly bus: MessageBusLike;
  readonly type?: string;
  readonly source?: string;
  readonly headers?: Record<string, string>;
  readonly onError?: (error: unknown, event: CircuitStateChangeEvent) => void;
}

export const DEFAULT_CIRCUIT_BREAKER_STATE_MESSAGE_TYPE =
  "forge.resilience.circuit.state_changed";

export type CircuitBreakerStatePublisher = (event: CircuitStateChangeEvent) => void;

/**
 * Return an `onStateChange` callback suitable for {@link circuitBreaker}.
 */
export function circuitBreakerStatePublisher(
  options: CircuitBreakerStatePublisherOptions,
): CircuitBreakerStatePublisher {
  const type = options.type ?? DEFAULT_CIRCUIT_BREAKER_STATE_MESSAGE_TYPE;
  const reportError = (error: unknown, event: CircuitStateChangeEvent): void => {
    try {
      options.onError?.(error, event);
    } catch {
      // Publishing is observational; error hooks must not affect callers either.
    }
  };
  return (event) => {
    try {
      void options.bus.publish({
        type,
        payload: { ...event, source: options.source },
        headers: options.headers,
        occurredAt: new Date(event.at),
      }).catch((error: unknown) => {
        reportError(error, event);
      });
    } catch (error) {
      reportError(error, event);
    }
  };
}

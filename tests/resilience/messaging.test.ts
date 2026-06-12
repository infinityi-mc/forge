import { describe, expect, test } from "bun:test";
import type { CircuitStateChangeEvent } from "../../src/resilience/circuit-breaker";
import {
  DEFAULT_CIRCUIT_BREAKER_STATE_MESSAGE_TYPE,
  circuitBreakerStatePublisher,
  type MessageBusLike,
} from "../../src/resilience/messaging";

const EVENT: CircuitStateChangeEvent = {
  from: "closed",
  to: "open",
  at: 1_700_000_000_000,
  reason: "failure-threshold",
  openedAt: 1_700_000_000_000,
  retryAt: 1_700_000_030_000,
};

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe("circuitBreakerStatePublisher", () => {
  test("publishes state-change events with default type, source, headers, and occurredAt", async () => {
    const messages: Parameters<MessageBusLike["publish"]>[0][] = [];
    const bus: MessageBusLike = {
      async publish(message) {
        messages.push(message);
      },
    };
    const publish = circuitBreakerStatePublisher({
      bus,
      source: "payments",
      headers: { tenant: "default" },
    });

    publish(EVENT);
    await flushMicrotasks();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: DEFAULT_CIRCUIT_BREAKER_STATE_MESSAGE_TYPE,
      payload: { ...EVENT, source: "payments" },
      headers: { tenant: "default" },
      occurredAt: new Date(EVENT.at),
    });
  });

  test("allows a custom message type", async () => {
    const messages: Parameters<MessageBusLike["publish"]>[0][] = [];
    const bus: MessageBusLike = {
      async publish(message) {
        messages.push(message);
      },
    };
    const publish = circuitBreakerStatePublisher({
      bus,
      type: "dependency.circuit.changed",
    });

    publish(EVENT);
    await flushMicrotasks();

    expect(messages[0]?.type).toBe("dependency.circuit.changed");
  });

  test("routes publish failures to onError without throwing", async () => {
    const error = new Error("broker down");
    const failures: Array<{ error: unknown; event: CircuitStateChangeEvent }> = [];
    const bus: MessageBusLike = {
      publish: async () => {
        throw error;
      },
    };
    const publish = circuitBreakerStatePublisher({
      bus,
      onError: (caught, event) => failures.push({ error: caught, event }),
    });

    expect(() => publish(EVENT)).not.toThrow();
    await flushMicrotasks();

    expect(failures).toEqual([{ error, event: EVENT }]);
  });

  test("isolates synchronous publish and onError failures", () => {
    const error = new Error("sync broker failure");
    const bus: MessageBusLike = {
      publish: () => {
        throw error;
      },
    };
    const publish = circuitBreakerStatePublisher({
      bus,
      onError: () => {
        throw new Error("observer failure");
      },
    });

    expect(() => publish(EVENT)).not.toThrow();
  });
});

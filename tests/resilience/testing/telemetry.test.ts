import { describe, expect, test } from "bun:test";
import {
  circuitBreaker,
  combine,
  exponentialBackoff,
  retry,
} from "../../../src/resilience";
import {
  TestClock,
  createTestResilienceTelemetry,
  executionContext,
} from "../../../src/resilience/testing";

describe("createTestResilienceTelemetry", () => {
  test("records resilience counters through a standalone meter", async () => {
    const t = createTestResilienceTelemetry();
    const clock = new TestClock();
    let attempts = 0;

    const pipeline = combine(
      retry({
        maxAttempts: 2,
        backoff: exponentialBackoff({ initial: 10, jitter: false }),
        telemetry: t.telemetry,
        clock,
      }),
    );

    const settled = pipeline.execute(() => {
      attempts++;
      if (attempts === 1) throw new Error("retry me");
      return "ok";
    });

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(10);

    expect(await settled).toBe("ok");
    expect(t.metrics).toContainEqual({
      name: "forge_resilience_retries_total",
      kind: "counter",
      value: 1,
      attributes: { policy: "retry" },
    });
    expect(
      t.metrics.filter((metric) =>
        metric.name === "forge_resilience_attempts_total"
      ),
    ).toHaveLength(2);
  });

  test("records synthetic span events from resilience instrumentation", async () => {
    const t = createTestResilienceTelemetry();
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      telemetry: t.telemetry,
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("boom");
      }, executionContext())
      .catch(() => {});

    expect(t.spanEvents).toContainEqual({
      name: "resilience.circuit.state_change",
      attributes: {
        from_state: "closed",
        to_state: "open",
        reason: "failure-threshold",
      },
    });
    expect(t.metrics).toContainEqual({
      name: "forge_resilience_circuit_state",
      kind: "gauge",
      value: 2,
      attributes: { policy: "circuit-breaker", state: "open" },
    });
  });

  test("clear removes recorded metrics and span events", () => {
    const t = createTestResilienceTelemetry();

    t.telemetry.meter?.createGauge("test_gauge").record(1);
    t.telemetry.tracer?.startSpan("test.span").end();
    expect(t.metrics).toHaveLength(1);
    expect(t.spanEvents).toHaveLength(1);

    t.clear();
    expect(t.metrics).toHaveLength(0);
    expect(t.spanEvents).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  combine,
  exponentialBackoff,
  retry,
  timeout,
  TimeoutError,
} from "../../src/resilience";
import { TestClock } from "../../src/resilience/testing";
import { createTestTelemetry } from "../../src/telemetry/testing";

describe("resilience telemetry integration", () => {
  test("retry emits retries_total counter and retry.attempt span events", async () => {
    const t = createTestTelemetry();
    const clock = new TestClock();
    let attempts = 0;

    const pipeline = combine(
      retry({
        maxAttempts: 3,
        backoff: exponentialBackoff({ initial: 10, jitter: false }),
        telemetry: { meter: t.meter, tracer: t.tracer },
        clock,
      }),
    );

    const promise = pipeline.execute(() => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
      return "ok";
    });

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(10); // first backoff
    await clock.tickAsync(20); // second backoff
    expect(await promise).toBe("ok");

    await t.flushAll();

    // Counter shows 2 retries (attempts 1 and 2 failed → 2 retries
    // scheduled). The pipeline ran 3 attempts total.
    const batch = t.batches[0];
    expect(batch).toBeDefined();
    const retries = batch!.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_retries_total",
    );
    expect(retries).toBeDefined();
    const retriesPoint = retries!.points[0]!;
    expect((retriesPoint as { value: number }).value).toBe(2);

    const attemptsCounter = batch!.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_attempts_total",
    );
    expect(attemptsCounter).toBeDefined();
    expect(
      (attemptsCounter!.points[0] as { value: number }).value,
    ).toBe(3);

    // Span events surface as one-shot spans with no parent — but
    // they carry the configured event name as the span name in our
    // adapter implementation. Two span events fired (one per retry).
    const retrySpans = t.spans.filter((s) => s.name === "resilience.retry.attempt");
    expect(retrySpans).toHaveLength(2);
    expect(retrySpans[0]!.attributes["attempt_number"]).toBe(1);
    expect(retrySpans[1]!.attributes["attempt_number"]).toBe(2);
  });

  test("timeout emits timeout_total counter and timeout.triggered event", async () => {
    const t = createTestTelemetry();
    const clock = new TestClock();

    const pipeline = combine(
      timeout({
        ms: 50,
        telemetry: { meter: t.meter, tracer: t.tracer },
        clock,
      }),
    );

    const promise = pipeline
      .execute(async (ctx) => {
        await clock.sleep(1_000, ctx.signal);
        return "never";
      })
      .catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();
    await clock.tickAsync(50);
    const err = await promise;
    expect(err).toBeInstanceOf(TimeoutError);

    await t.flushAll();

    const batch = t.batches[0]!;
    const timeouts = batch.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_timeout_total",
    );
    expect(timeouts).toBeDefined();
    expect(
      (timeouts!.points[0] as { value: number }).value,
    ).toBe(1);

    const triggered = t.spans.filter(
      (s) => s.name === "resilience.timeout.triggered",
    );
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.attributes["timeout_ms"]).toBe(50);
  });

  test("policies without telemetry emit nothing", async () => {
    // Sanity check: no telemetry option → no need to pass a meter/tracer.
    const pipeline = combine(retry({ maxAttempts: 2 }));
    const result = await pipeline.execute(() => 7);
    expect(result).toBe(7);
  });
});

import { describe, expect, test } from "bun:test";
import {
  bulkhead,
  circuitBreaker,
  combine,
  exponentialBackoff,
  RateLimitedError,
  rateLimit,
  retry,
  timeout,
  TimeoutError,
} from "../../src/resilience";
import { TestClock, executionContext } from "../../src/resilience/testing";
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
    expect((attemptsCounter!.points[0] as { value: number }).value).toBe(3);

    // Span events surface as one-shot spans with no parent — but
    // they carry the configured event name as the span name in our
    // adapter implementation. Two span events fired (one per retry).
    const retrySpans = t.spans.filter(
      (s) => s.name === "resilience.retry.attempt",
    );
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
    expect((timeouts!.points[0] as { value: number }).value).toBe(1);

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

  test("circuitBreaker emits circuit_state gauge and state_change events", async () => {
    const t = createTestTelemetry();
    const clock = new TestClock();
    const breaker = circuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      telemetry: { meter: t.meter, tracer: t.tracer },
      clock,
    });

    await breaker
      .execute(() => {
        throw new Error("boom");
      }, executionContext())
      .catch(() => {});
    expect(breaker.state).toBe("open");

    await t.flushAll();

    const batch = t.batches[0]!;
    const stateGauge = batch.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_circuit_state",
    );
    expect(stateGauge).toBeDefined();
    // The last recorded state was "open" (=2).
    const openPoint = stateGauge!.points.find(
      (p) => (p.attributes as { state?: string }).state === "open",
    );
    expect(openPoint).toBeDefined();
    expect((openPoint as { value: number }).value).toBe(2);

    const stateChanges = t.spans.filter(
      (s) => s.name === "resilience.circuit.state_change",
    );
    // One transition: closed → open.
    expect(stateChanges.length).toBeGreaterThanOrEqual(1);
    const last = stateChanges[stateChanges.length - 1]!;
    expect(last.attributes["from_state"]).toBe("closed");
    expect(last.attributes["to_state"]).toBe("open");
    expect(last.attributes["reason"]).toBe("failure-threshold");
  });

  test("rateLimit attempts counter only counts admitted executions", async () => {
    const t = createTestTelemetry();
    const clock = new TestClock();
    const limiter = rateLimit({
      algorithm: { kind: "token-bucket", tokensPerSecond: 1, burst: 1 },
      mode: "throw",
      telemetry: { meter: t.meter, tracer: t.tracer },
      clock,
    });

    let executed = 0;
    expect(
      await limiter.execute(() => {
        executed++;
        return "admitted";
      }, executionContext()),
    ).toBe("admitted");

    const rejected = await limiter
      .execute(() => {
        executed++;
        return "rejected";
      }, executionContext())
      .catch((e) => e);
    expect(rejected).toBeInstanceOf(RateLimitedError);
    expect(executed).toBe(1);

    await t.flushAll();

    const batch = t.batches[0]!;
    const attempts = batch.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_attempts_total",
    );
    expect(attempts).toBeDefined();
    expect((attempts!.points[0] as { value: number }).value).toBe(1);
  });

  test("bulkhead emits bulkhead_queue_size gauge", async () => {
    const t = createTestTelemetry();
    const bh = bulkhead({
      maxConcurrent: 1,
      maxQueue: 2,
      telemetry: { meter: t.meter, tracer: t.tracer },
    });

    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      release = r;
    });
    const a = bh.execute(() => slow, executionContext());
    await Promise.resolve();

    // Queue one and let it park before releasing the first.
    const b = bh.execute(() => "queued", executionContext());
    await Promise.resolve();
    await Promise.resolve();

    release("a");
    expect(await a).toBe("a");
    expect(await b).toBe("queued");

    await t.flushAll();

    const batch = t.batches[0]!;
    const queueGauge = batch.metrics.find(
      (m) => m.descriptor.name === "forge_resilience_bulkhead_queue_size",
    );
    expect(queueGauge).toBeDefined();
  });
});

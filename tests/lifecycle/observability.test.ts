import { describe, expect, test } from "bun:test";
import { boot } from "../../src/lifecycle";
import {
  NOOP_SPAN,
  createLifecycleMetrics,
  withSpan,
} from "../../src/lifecycle/observability";
import { TestClock, fakeComponent } from "../../src/lifecycle/testing";
import type {
  Attributes,
  MeterLike,
  SpanLike,
  TracerLike,
} from "../../src/lifecycle/types";

interface Recorded {
  readonly name: string;
  readonly value: number;
  readonly attributes?: Attributes;
}

function recordingMeter(): { meter: MeterLike; records: Recorded[] } {
  const records: Recorded[] = [];
  const meter: MeterLike = {
    createCounter(name) {
      return { add: (value, attributes) => records.push({ name, value, attributes }) };
    },
    createHistogram(name) {
      return { record: (value, attributes) => records.push({ name, value, attributes }) };
    },
    createUpDownCounter(name) {
      return { add: (value, attributes) => records.push({ name, value, attributes }) };
    },
  };
  return { meter, records };
}

describe("createLifecycleMetrics", () => {
  test("returns safe no-ops when no telemetry is injected", () => {
    const metrics = createLifecycleMetrics();
    expect(() => {
      metrics.bootDuration.record(1);
      metrics.startDuration.record(1, { component: "a", outcome: "ok" });
      metrics.stopTimeout.add(1, { component: "a" });
      metrics.ready.add(1);
      metrics.healthCheckDuration.record(1, { check: "a", status: "healthy" });
    }).not.toThrow();
  });

  test("a throwing instrument can never break an emit (telemetry mid-start/shut)", () => {
    const meter: MeterLike = {
      createCounter() {
        return {
          add() {
            throw new Error("not started yet");
          },
        };
      },
      createHistogram() {
        return {
          record() {
            throw new Error("already shut down");
          },
        };
      },
      createUpDownCounter() {
        return {
          add() {
            throw new Error("not started yet");
          },
        };
      },
    };
    const metrics = createLifecycleMetrics({ meter });
    expect(() => {
      metrics.bootDuration.record(1);
      metrics.ready.add(1);
      metrics.stopTimeout.add(1);
    }).not.toThrow();
  });
});

describe("boot — metric surface", () => {
  test("emits boot/start/ready metrics with a meter and the ready gauge flips on shutdown", async () => {
    const { meter, records } = recordingMeter();
    const clock = new TestClock();
    const app = await boot({
      components: [fakeComponent("a", { clock }), fakeComponent("b", { clock })],
      clock,
      installSignals: false,
      exit: () => {},
      shutdownTimeout: 1_000,
      telemetry: { meter },
    });

    const names = records.map((r) => r.name);
    expect(names).toContain("lifecycle.boot.duration");
    expect(names).toContain("lifecycle.component.start.duration");
    const readyDeltas = records.filter((r) => r.name === "lifecycle.ready");
    expect(readyDeltas.map((r) => r.value)).toEqual([1]);

    await app.stop();
    const after = records.filter((r) => r.name === "lifecycle.ready").map((r) => r.value);
    expect(after).toEqual([1, -1]);
    expect(records.map((r) => r.name)).toContain("lifecycle.shutdown.duration");
    expect(records.map((r) => r.name)).toContain("lifecycle.component.stop.duration");
  });

  test("emits nothing without a meter and still boots/stops cleanly", async () => {
    const clock = new TestClock();
    const exitCodes: number[] = [];
    const app = await boot({
      components: [fakeComponent("a", { clock })],
      clock,
      installSignals: false,
      exit: (code) => exitCodes.push(code),
      shutdownTimeout: 1_000,
    });
    expect(app.ready).toBe(true);
    await app.stop();
    expect(exitCodes).toEqual([0]);
  });

  test("does not emit ready if a signal starts shutdown during boot", async () => {
    const { meter, records } = recordingMeter();
    const exitCodes: number[] = [];
    const signal = "SIGUSR1" as NodeJS.Signals;
    const app = await boot({
      components: [
        {
          name: "signal",
          start() {
            process.emit(signal);
          },
        },
      ],
      installSignals: true,
      signals: [signal],
      exit: (code) => exitCodes.push(code),
      telemetry: { meter },
    });

    await app.done;

    expect(app.ready).toBe(false);
    expect(exitCodes).toEqual([0]);
    expect(records.filter((r) => r.name === "lifecycle.ready")).toEqual([]);
  });

  test("stops a component that emits a signal during startup", async () => {
    const events: string[] = [];
    const signal = "SIGUSR1" as NodeJS.Signals;
    const app = await boot({
      components: [
        {
          name: "signal",
          start() {
            events.push("signal:start");
            process.emit(signal);
          },
          stop() {
            events.push("signal:stop");
          },
        },
      ],
      installSignals: true,
      signals: [signal],
      exit: () => {},
    });

    await app.done;

    expect(events).toEqual(["signal:start", "signal:stop"]);
  });
});

describe("withSpan", () => {
  test("runs fn directly and returns its value when no tracer is present", async () => {
    const result = await withSpan(undefined, "x", {}, async (span) => {
      expect(span).toBe(NOOP_SPAN);
      return 42;
    });
    expect(result).toBe(42);
  });

  test("marks ok on success and error on throw, always ending the span", async () => {
    const events: string[] = [];
    const span: SpanLike = {
      setAttribute() {
        return undefined;
      },
      setStatus(status) {
        events.push(`status:${status.code}`);
        return undefined;
      },
      end() {
        events.push("end");
      },
    };
    const tracer: TracerLike = {
      startSpan() {
        return span;
      },
    };

    await withSpan(tracer, "ok", {}, async () => {});
    expect(events).toEqual(["status:ok", "end"]);

    events.length = 0;
    await expect(
      withSpan(tracer, "bad", {}, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(events).toEqual(["status:error", "end"]);
  });
});

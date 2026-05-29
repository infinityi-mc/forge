import { describe, expect, test } from "bun:test";
import { ShutdownError } from "../../src/lifecycle";
import {
  TestClock,
  createTestApp,
  fakeComponent,
} from "../../src/lifecycle/testing";

describe("graceful shutdown", () => {
  test("stops components in strict reverse order and exits 0", async () => {
    const events: string[] = [];
    const components = ["telemetry", "db", "http"].map((n) =>
      fakeComponent(n, { events }),
    );
    const { app, exitCodes } = await createTestApp({ components });

    await app.stop();

    expect(events.slice(3)).toEqual(["http:stop", "db:stop", "telemetry:stop"]);
    expect(app.ready).toBe(false);
    expect(exitCodes).toEqual([0]);
  });

  test("app.stop() is idempotent — concurrent calls share one shutdown", async () => {
    const events: string[] = [];
    const { app, exitCodes } = await createTestApp({
      components: [fakeComponent("a", { events })],
    });

    const a = app.stop();
    const b = app.stop("again");
    await Promise.all([a, b]);

    // Only one stop ran, one exit was issued.
    expect(events.filter((e) => e === "a:stop")).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
  });

  test("app.done resolves after shutdown completes", async () => {
    const { app } = await createTestApp({
      components: [fakeComponent("a")],
    });
    let resolved = false;
    void app.done.then(() => {
      resolved = true;
    });
    await app.stop();
    // Give the done resolver a microtask to run.
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  test("a stop() that throws is collected and yields a non-zero exit", async () => {
    const { app, exitCodes } = await createTestApp({
      components: [
        fakeComponent("ok"),
        fakeComponent("bad", { failStop: new Error("stop boom") }),
      ],
    });
    await app.stop();
    expect(exitCodes).toEqual([1]);
  });

  test("waits preStopDelayMs before stopping", async () => {
    const clock = new TestClock();
    const events: string[] = [];
    const { app } = await createTestApp({
      components: [fakeComponent("a", { events, clock })],
      clock,
      preStopDelayMs: 5_000,
    });

    const settled = app.stop();
    expect(events).not.toContain("a:stop"); // still draining
    await clock.tickAsync(5_000);
    await settled;
    expect(events).toContain("a:stop");
  });
});

describe("bounded shutdown — timeout slices", () => {
  test("abandons a component that overruns its slice and proceeds", async () => {
    const clock = new TestClock();
    const events: string[] = [];
    const a = fakeComponent("a", { events, clock });
    const slow = fakeComponent("slow", { events, clock, stopDelayMs: 10_000 });
    const { app, exitCodes } = await createTestApp({
      components: [a, slow],
      clock,
      shutdownTimeout: 100,
    });

    const settled = app.stop();
    await clock.tickAsync(50); // fire slow's 50ms slice
    await settled;

    expect(events).toContain("slow:stop");
    expect(slow.stopped).toBe(false); // abandoned mid-flight
    expect(a.stopped).toBe(true); // shutdown still proceeded
    expect(exitCodes).toEqual([1]);
  });

  test("ShutdownError carries the offending component name", () => {
    const err = new ShutdownError("boom", { component: "db" });
    expect(err.component).toBe("db");
    expect(err.name).toBe("ShutdownError");
  });
});

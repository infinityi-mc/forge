import { describe, expect, test } from "bun:test";
import {
  ComponentRegistrationError,
  StartupError,
  asComponent,
  forge,
} from "../../src/lifecycle";
import {
  createTestApp,
  fakeComponent,
} from "../../src/lifecycle/testing";

describe("forge.boot — startup", () => {
  test("starts components in array order and reports ready", async () => {
    const events: string[] = [];
    const components = ["telemetry", "db", "http"].map((n) =>
      fakeComponent(n, { events }),
    );
    const { app } = await createTestApp({ components });

    expect(app.ready).toBe(true);
    expect(events).toEqual(["telemetry:start", "db:start", "http:start"]);
    expect(app.components.map((c) => c.name)).toEqual([
      "telemetry",
      "db",
      "http",
    ]);
  });

  test("components without a start hook are still tracked", async () => {
    const c = fakeComponent("logger-only", { noStart: true });
    const { app } = await createTestApp({ components: [c] });
    expect(app.ready).toBe(true);
    expect(app.components).toContain(c);
  });

  test("passes a per-component logger and an AbortSignal to start()", async () => {
    let sawSignal: AbortSignal | undefined;
    let sawLogger: unknown;
    const component = asComponent("probe", {
      start: (ctx) => {
        sawSignal = ctx.signal;
        sawLogger = ctx.logger;
      },
    });
    await createTestApp({ components: [component] });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(typeof (sawLogger as { info: unknown }).info).toBe("function");
  });
});

describe("forge.boot — validation", () => {
  test("rejects a blank component name", () => {
    expect(() =>
      asComponent("   ", { start: () => {} }),
    ).toThrow(ComponentRegistrationError);
  });

  test("rejects duplicate component names", async () => {
    await expect(
      createTestApp({
        components: [fakeComponent("dup"), fakeComponent("dup")],
      }),
    ).rejects.toThrow(ComponentRegistrationError);
  });
});

describe("forge.boot — rollback on start failure", () => {
  test("aborts boot, rolls back in reverse, and throws StartupError", async () => {
    const events: string[] = [];
    const components = [
      fakeComponent("a", { events }),
      fakeComponent("b", { events }),
      fakeComponent("c", { events, failStart: new Error("c is down") }),
      fakeComponent("d", { events }),
    ];

    let error: unknown;
    try {
      await createTestApp({ components });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).component).toBe("c");
    expect((error as StartupError).cause).toBeInstanceOf(Error);
    // a, b started; c failed; d never reached. Rollback stops b then a.
    expect(events).toEqual([
      "a:start",
      "b:start",
      "c:start",
      "b:stop",
      "a:stop",
    ]);
  });

  test("a start that overruns its startTimeout is treated as a failure", async () => {
    // Real timers here: a hung start must be aborted by the timeout signal.
    const events: string[] = [];
    const components = [
      fakeComponent("a", { events }),
      fakeComponent("slow", { events, startDelayMs: 5_000 }),
    ];

    let error: unknown;
    try {
      await forge.boot({
        components,
        startTimeout: 20,
        installSignals: false,
        exit: () => {},
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).component).toBe("slow");
    expect(events).toContain("a:stop");
  });
});

describe("forge.boot — shutdown during startup", () => {
  test("stops a component whose start finishes after shutdown begins", async () => {
    const events: string[] = [];
    const signal = "SIGUSR1" as NodeJS.Signals;
    const app = await forge.boot({
      components: [
        {
          name: "slow",
          async start() {
            events.push("slow:start");
            process.emit(signal);
            await Promise.resolve();
          },
          stop() {
            events.push("slow:stop");
          },
        },
        fakeComponent("never", { events }),
      ],
      signals: [signal],
      installSignals: true,
      exit: () => {},
    });

    await app.done;

    expect(app.ready).toBe(false);
    expect(events).toEqual(["slow:start", "slow:stop"]);
  });
});

describe("forge.boot — façade", () => {
  test("forge.boot exposes the same orchestrator", async () => {
    const app = await forge.boot({
      components: [fakeComponent("only")],
      installSignals: false,
      exit: () => {},
    });
    expect(app.ready).toBe(true);
    await app.stop();
  });
});

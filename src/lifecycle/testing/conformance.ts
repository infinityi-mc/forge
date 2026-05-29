/**
 * Conformance scenarios for `forge/lifecycle`.
 *
 * {@link STANDARD_LIFECYCLE_SCENARIOS} exercises the invariants any orchestrator
 * (the stock {@link boot}, or a custom one) must satisfy:
 *
 * - components start in array order and stop in strict reverse order;
 * - a failing `start()` aborts boot and rolls back the already-started
 *   components in reverse (`StartupError`, app never `ready`);
 * - a `stop()` that exceeds its slice is abandoned and shutdown proceeds
 *   (recorded via a non-zero exit, not thrown to the caller);
 * - readiness is false before boot completes and immediately on shutdown;
 * - a second identical signal forces exit;
 * - the signal disposer removes every listener (no leaks between tests);
 * - readiness gating: a closed gate / a failing critical check is not-ready,
 *   while a non-critical failure degrades but stays ready;
 * - liveness independence: liveness never calls downstream checks.
 *
 * Errors are plain `Error`s so the suite is framework-agnostic. Pass a custom
 * {@link BootFn} to {@link assertConformance} to validate an alternative
 * orchestrator; it defaults to the stock {@link boot}.
 *
 * @module
 */

import { boot as stockBoot } from "../boot";
import { StartupError } from "../errors";
import { createProbe } from "../health";
import { installSignalHandlers } from "../signals";
import type { Application, BootOptions } from "../types";
import { TestClock } from "./clock";
import { fakeComponent } from "./index";

/** The orchestrator under test — `forge.boot` by default. */
export type BootFn = (options: BootOptions) => Promise<Application>;

/** A single conformance scenario. `run` resolves on success or throws. */
export interface LifecycleConformanceScenario {
  name: string;
  run(boot: BootFn): Promise<void>;
}

/** A minimal in-memory signal emitter for the signal-handling scenarios. */
interface FakeSignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
  emit(signal: NodeJS.Signals): void;
  count(signal: NodeJS.Signals): number;
}

function fakeSignalSource(): FakeSignalSource {
  const listeners = new Map<NodeJS.Signals, Set<(s: NodeJS.Signals) => void>>();
  return {
    on(signal, listener) {
      const set = listeners.get(signal) ?? new Set();
      set.add(listener);
      listeners.set(signal, set);
    },
    off(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal) {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener(signal);
      }
    },
    count(signal) {
      return listeners.get(signal)?.size ?? 0;
    },
  };
}

export const STANDARD_LIFECYCLE_SCENARIOS: readonly LifecycleConformanceScenario[] =
  [
    {
      name: "components start in array order and stop in strict reverse order",
      async run(boot) {
        const clock = new TestClock();
        const events: string[] = [];
        const components = ["a", "b", "c"].map((n) =>
          fakeComponent(n, { events, clock }),
        );
        const app = await boot({
          components,
          clock,
          installSignals: false,
          exit: () => {},
          shutdownTimeout: 1_000,
        });
        if (events.join(",") !== "a:start,b:start,c:start") {
          throw new Error(`expected start order a,b,c; got [${events.join(",")}]`);
        }
        await app.stop();
        if (
          events.join(",") !==
          "a:start,b:start,c:start,c:stop,b:stop,a:stop"
        ) {
          throw new Error(
            `expected reverse stop order c,b,a; got [${events.join(",")}]`,
          );
        }
      },
    },
    {
      name: "a failing start aborts boot and rolls back in reverse",
      async run(boot) {
        const clock = new TestClock();
        const events: string[] = [];
        const components = [
          fakeComponent("a", { events, clock }),
          fakeComponent("b", { events, clock, failStart: true }),
          fakeComponent("c", { events, clock }),
        ];
        let error: unknown;
        try {
          await boot({
            components,
            clock,
            installSignals: false,
            exit: () => {},
            shutdownTimeout: 1_000,
          });
        } catch (e) {
          error = e;
        }
        if (!(error instanceof StartupError)) {
          throw new Error(
            `expected boot to reject with StartupError, got ${describe(error)}`,
          );
        }
        if (error.component !== "b") {
          throw new Error(
            `expected StartupError.component="b", got "${error.component}"`,
          );
        }
        if (events.join(",") !== "a:start,b:start,a:stop") {
          throw new Error(
            `expected rollback to stop only "a"; got [${events.join(",")}]`,
          );
        }
      },
    },
    {
      name: "a stop that exceeds its slice is abandoned and shutdown proceeds",
      async run(boot) {
        const clock = new TestClock();
        const events: string[] = [];
        const exitCodes: number[] = [];
        const a = fakeComponent("a", { events, clock });
        const b = fakeComponent("b", { events, clock, stopDelayMs: 10_000 });
        const app = await boot({
          components: [a, b],
          clock,
          installSignals: false,
          exit: (code) => exitCodes.push(code),
          shutdownTimeout: 100,
        });
        const settled = app.stop();
        // b stops first (reverse order) and hangs past its 50ms slice.
        await clock.tickAsync(50);
        await settled;
        if (!events.includes("b:stop")) {
          throw new Error("expected b:stop to have begun");
        }
        if (b.stopped) {
          throw new Error("expected b to be abandoned, not to complete its stop");
        }
        if (!events.includes("a:stop") || !a.stopped) {
          throw new Error("expected shutdown to proceed and stop a after abandoning b");
        }
        if (exitCodes[0] !== 1) {
          throw new Error(
            `expected exit code 1 after an abandoned stop, got ${exitCodes[0]}`,
          );
        }
      },
    },
    {
      name: "readiness is false before boot completes and immediately on shutdown",
      async run(boot) {
        const clock = new TestClock();
        const app = await boot({
          components: [fakeComponent("a", { clock })],
          clock,
          installSignals: false,
          exit: () => {},
          shutdownTimeout: 1_000,
        });
        const readyAfterBoot: boolean = app.ready;
        if (!readyAfterBoot) {
          throw new Error("expected ready=true after a successful boot");
        }
        const settled = app.stop();
        const readyOnShutdown: boolean = app.ready;
        if (readyOnShutdown) {
          throw new Error("expected ready=false immediately when shutdown begins");
        }
        await settled;
        const readyAfterShutdown: boolean = app.ready;
        if (readyAfterShutdown) {
          throw new Error("expected ready to stay false after shutdown");
        }
      },
    },
    {
      name: "a second identical signal forces exit",
      async run() {
        const source = fakeSignalSource();
        const exitCodes: number[] = [];
        let calls = 0;
        const dispose = installSignalHandlers({
          signals: ["SIGTERM"],
          onSignal: () => {
            calls++;
          },
          source,
          exit: (code) => exitCodes.push(code),
        });
        source.emit("SIGTERM");
        source.emit("SIGTERM");
        dispose();
        if (calls !== 1) {
          throw new Error(`expected onSignal to fire once, got ${calls}`);
        }
        if (exitCodes.join(",") !== "1") {
          throw new Error(
            `expected a forced exit(1) on the second signal, got [${exitCodes.join(",")}]`,
          );
        }
      },
    },
    {
      name: "the signal disposer removes every listener (no leaks)",
      async run() {
        const source = fakeSignalSource();
        const dispose = installSignalHandlers({
          signals: ["SIGTERM", "SIGINT"],
          onSignal: () => {},
          source,
          exit: () => {},
        });
        if (source.count("SIGTERM") !== 1 || source.count("SIGINT") !== 1) {
          throw new Error("expected one listener installed per signal");
        }
        dispose();
        if (source.count("SIGTERM") !== 0 || source.count("SIGINT") !== 0) {
          throw new Error("expected the disposer to remove all listeners");
        }
      },
    },
    {
      name: "readiness gating: closed gate and critical failure are not-ready, non-critical only degrades",
      async run() {
        // A closed gate (startup/shutdown) is not-ready without touching checks.
        let calledClosedGate = false;
        const gated = createProbe({
          ready: () => false,
          checks: [
            {
              name: "db",
              critical: true,
              check: () => {
                calledClosedGate = true;
                return { status: "healthy" };
              },
            },
          ],
        });
        const whileGated = await gated.check();
        if (whileGated.ready) {
          throw new Error("expected not-ready while the boot gate is closed");
        }
        if (calledClosedGate) {
          throw new Error("expected a closed gate to short-circuit before downstream checks");
        }

        // An open gate with a failing *critical* check → not-ready + unhealthy.
        const critical = createProbe({
          ready: () => true,
          checks: [{ name: "db", critical: true, check: () => ({ status: "unhealthy" }) }],
        });
        const criticalResult = await critical.check();
        if (criticalResult.ready || criticalResult.status !== "unhealthy") {
          throw new Error(
            `expected a critical failure to be not-ready+unhealthy; got ready=${criticalResult.ready} status=${criticalResult.status}`,
          );
        }

        // A failing *non-critical* check → still ready, but degraded.
        const nonCritical = createProbe({
          ready: () => true,
          checks: [{ name: "cache", critical: false, check: () => ({ status: "unhealthy" }) }],
        });
        const degraded = await nonCritical.check();
        if (!degraded.ready || degraded.status !== "degraded") {
          throw new Error(
            `expected a non-critical failure to stay ready but degrade; got ready=${degraded.ready} status=${degraded.status}`,
          );
        }
      },
    },
    {
      name: "liveness independence: liveness never calls downstream checks",
      async run() {
        let downstreamCalls = 0;
        const probe = createProbe({
          ready: () => true,
          live: () => true,
          checks: [
            {
              name: "db",
              critical: true,
              check: () => {
                downstreamCalls++;
                return { status: "unhealthy" };
              },
            },
          ],
        });
        const live = probe.liveness();
        if (live.status !== "healthy" || !live.ready) {
          throw new Error(
            `expected liveness healthy regardless of downstreams; got status=${live.status} ready=${live.ready}`,
          );
        }
        if (downstreamCalls !== 0) {
          throw new Error(
            `expected liveness to call no downstream checks, got ${downstreamCalls}`,
          );
        }
        // …and a flipped liveness gate reports unhealthy without any checks.
        const wedged = createProbe({
          live: () => false,
          checks: [{ name: "db", check: () => ({ status: "healthy" }) }],
        });
        const dead = wedged.liveness();
        if (dead.status !== "unhealthy" || dead.ready) {
          throw new Error("expected a closed liveness gate to report unhealthy/not-ready");
        }
      },
    },
  ];

/**
 * Run the conformance scenarios against an orchestrator. Defaults to the stock
 * {@link boot}; pass a custom {@link BootFn} to validate your own.
 *
 * @example
 * ```ts
 * import { assertConformance } from "forge/lifecycle/testing";
 * await assertConformance();
 * ```
 */
export async function assertConformance(
  boot: BootFn = stockBoot,
  scenarios: readonly LifecycleConformanceScenario[] = STANDARD_LIFECYCLE_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(boot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `lifecycle conformance: "${scenario.name}" failed — ${message}`,
        { cause: error },
      );
    }
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.constructor.name}: ${value.message}`;
  return String(value);
}

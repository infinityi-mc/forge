/**
 * Test helpers for `forge/lifecycle`.
 *
 * Testability is a first-class feature: this module ships a deterministic
 * {@link TestClock}, a {@link fakeComponent} that records call order and can be
 * told to delay or throw, a {@link createTestApp} harness that boots **without**
 * touching real process signal handlers and with an injected `exit` (so a test
 * never kills the runner), and the {@link STANDARD_LIFECYCLE_SCENARIOS}
 * conformance suite with {@link assertConformance}.
 *
 * @module
 */

import { boot } from "../boot";
import { realClock } from "../clock";
import type {
  Application,
  Clock,
  Component,
  HealthContext,
  HealthResult,
  LifecycleContext,
  Logger,
} from "../types";
import { TestClock } from "./clock";

export { TestClock } from "./clock";
export {
  STANDARD_LIFECYCLE_SCENARIOS,
  assertConformance,
  type BootFn,
  type LifecycleConformanceScenario,
} from "./conformance";

/** Options controlling a {@link fakeComponent}. */
export interface FakeComponentOptions {
  /** Shared event log to append to. A private one is created when omitted. */
  readonly events?: string[];
  /** Clock backing `startDelayMs`/`stopDelayMs`. Default {@link realClock}. */
  readonly clock?: Clock;
  /** Delay `start()` by this many ms (use a {@link TestClock} to drive it). */
  readonly startDelayMs?: number;
  /** Delay `stop()` by this many ms. */
  readonly stopDelayMs?: number;
  /** Make `start()` reject — `true` for a default error, or a specific one. */
  readonly failStart?: boolean | Error;
  /** Make `stop()` reject — `true` for a default error, or a specific one. */
  readonly failStop?: boolean | Error;
  /** Health result (or factory) returned by `healthcheck()`. */
  readonly health?: HealthResult | (() => HealthResult);
  /** Omit the `start` hook entirely (component only stops). */
  readonly noStart?: boolean;
  /** Omit the `stop` hook entirely (component only starts). */
  readonly noStop?: boolean;
}

/** A {@link Component} that records the order its hooks were invoked. */
export interface FakeComponent extends Component {
  /** Appended `${name}:start` / `${name}:stop` / `${name}:health` markers. */
  readonly events: string[];
  /** True once `start()` has completed. */
  readonly started: boolean;
  /** True once `stop()` has completed. */
  readonly stopped: boolean;
}

/**
 * Build a {@link Component} whose hooks record their invocation order into a
 * shared `events` array — the primitive for ordering assertions. It can be told
 * to delay (to exercise timeout slices) or throw (to exercise rollback).
 */
export function fakeComponent(
  name: string,
  options: FakeComponentOptions = {},
): FakeComponent {
  const events = options.events ?? [];
  const clock = options.clock ?? realClock;
  let started = false;
  let stopped = false;

  async function delay(ms: number | undefined, signal: AbortSignal): Promise<void> {
    if (ms && ms > 0) {
      await clock.sleep(ms, signal);
    }
  }

  const component: FakeComponent = {
    name,
    get events() {
      return events;
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    healthcheck(_ctx: HealthContext): HealthResult {
      events.push(`${name}:health`);
      if (typeof options.health === "function") return options.health();
      return options.health ?? { status: "healthy" };
    },
  };

  if (!options.noStart) {
    component.start = async (ctx: LifecycleContext): Promise<void> => {
      events.push(`${name}:start`);
      await delay(options.startDelayMs, ctx.signal);
      if (options.failStart) {
        throw toError(options.failStart, `${name} failed to start`);
      }
      started = true;
    };
  }

  if (!options.noStop) {
    component.stop = async (ctx: LifecycleContext): Promise<void> => {
      events.push(`${name}:stop`);
      await delay(options.stopDelayMs, ctx.signal);
      if (options.failStop) {
        throw toError(options.failStop, `${name} failed to stop`);
      }
      stopped = true;
    };
  }

  return component;
}

function toError(value: boolean | Error, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/** A booted test application plus the deterministic clock and recorded exits. */
export interface TestApp {
  /** The booted {@link Application}. */
  readonly app: Application;
  /** The {@link TestClock} driving every timeout. Advance it with `tickAsync`. */
  readonly clock: TestClock;
  /** Exit codes passed to the injected `exit` hook, in order. */
  readonly exitCodes: number[];
}

/** Options for {@link createTestApp}. */
export interface CreateTestAppOptions {
  readonly components: readonly Component[];
  readonly shutdownTimeout?: number;
  readonly startTimeout?: number;
  readonly preStopDelayMs?: number;
  /** Provide an existing {@link TestClock} (e.g. shared with fake components). */
  readonly clock?: TestClock;
  readonly logger?: Logger;
}

/**
 * Boot an {@link Application} wired for tests: no real signal handlers, a
 * deterministic {@link TestClock}, and an injected `exit` that records codes
 * instead of terminating the runner.
 */
export async function createTestApp(
  options: CreateTestAppOptions,
): Promise<TestApp> {
  const clock = options.clock ?? new TestClock();
  const exitCodes: number[] = [];
  const app = await boot({
    components: options.components,
    shutdownTimeout: options.shutdownTimeout,
    startTimeout: options.startTimeout,
    preStopDelayMs: options.preStopDelayMs,
    clock,
    logger: options.logger,
    installSignals: false,
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  return { app, clock, exitCodes };
}

/**
 * `forge/lifecycle` — the conductor of a Forge application.
 *
 * It owns the *order* components start in, the *reverse order* they stop in,
 * and how the process is brought down cleanly on `SIGTERM`. Components are plain
 * objects satisfying the tiny {@link Component} seam — no base class, no
 * decorators, no DI container. Boot starts them in array order and fails fast
 * (rolling back) if any `start()` rejects; shutdown stops them in strict reverse
 * within a bounded budget so a hung component can never block the process.
 *
 * This entry-point exposes the PR A surface: the {@link forge} façade,
 * {@link boot}, {@link asComponent}, the error taxonomy, and the core contracts.
 * Health probes and the full observability surface follow in PR B; first-class
 * module adapters follow in PR C.
 *
 * @example Minimal usage
 * ```ts
 * import { forge, asComponent } from "forge/lifecycle";
 *
 * const app = await forge.boot({
 *   components: [
 *     asComponent("db", { start: () => db.ping(), stop: () => db.shutdown() }),
 *     asComponent("http", { start: () => { server = serve(); }, stop: () => server.stop(true) }),
 *   ],
 *   shutdownTimeout: 30_000,
 * });
 *
 * await app.done; // resolves after graceful shutdown
 * ```
 *
 * @module
 */

import { boot } from "./boot";
import type { Application, BootOptions } from "./types";

export { boot } from "./boot";
export { asComponent, type ComponentHooks } from "./component";
export { realClock } from "./clock";

export {
  ComponentRegistrationError,
  HealthCheckError,
  LifecycleError,
  ShutdownError,
  ShutdownTimeoutError,
  StartupError,
} from "./errors";

export { installSignalHandlers } from "./signals";
export type { SignalHandlerOptions, SignalSource } from "./signals";

export type {
  Application,
  Attributes,
  BootOptions,
  Clock,
  Component,
  CounterLike,
  ExitFn,
  HealthContext,
  HealthResult,
  HealthStatus,
  HistogramLike,
  LifecycleContext,
  LifecycleTelemetry,
  LogAttributes,
  Logger,
  MeterLike,
  SpanLike,
  TracerLike,
  UpDownCounterLike,
} from "./types";

/**
 * The README's façade: `import { forge } from "forge/lifecycle"`. A small,
 * stateless object — not a singleton holding global app state.
 */
export const forge: {
  boot(options: BootOptions): Promise<Application>;
} = {
  boot,
};

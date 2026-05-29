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
 * This entry-point exposes the {@link forge} façade, {@link boot},
 * {@link asComponent}, the error taxonomy, the core contracts, the health-probe
 * surface, and the official module adapters (`databaseComponent`,
 * `httpServerComponent`, the messaging adapters).
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

export {
  consumerComponent,
  databaseComponent,
  httpServerComponent,
  messageBusComponent,
  poolComponent,
  relayComponent,
  workerComponent,
} from "./adapters";
export type {
  AdapterOptions,
  DatabaseComponentOptions,
  DatabaseLike,
  HttpServerComponentOptions,
  HttpServerLike,
  MessageBusLike,
  PoolLike,
  StartStopLike,
} from "./adapters";

export { createProbe, healthRoutes, startHealthServer } from "./health";
export type {
  AggregateHealth,
  HealthCheck,
  HealthRoutes,
  HealthRoutesOptions,
  HealthServer,
  HealthServerOptions,
  Probe,
  ProbeOptions,
} from "./health";

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

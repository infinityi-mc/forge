/**
 * `forge/lifecycle/adapters` — thin official adapters that wrap
 * `forge/telemetry`, `forge/config`, `forge/preference`, `forge/data`,
 * `forge/http`, `forge/messaging`, and `forge/resilience` objects into
 * {@link Component}s with sensible `healthcheck`s, so the Quick Start
 * `components: [db, http, ...]` "just works".
 *
 * The adapters are typed against minimal structural `*Like` interfaces, so they
 * add **no** hard dependency on the other modules — the real objects already
 * conform.
 *
 * @module
 */

export { configComponent } from "./config";
export { databaseComponent, poolComponent } from "./data";
export { httpServerComponent } from "./http";
export {
  consumerComponent,
  messageBusComponent,
  relayComponent,
  workerComponent,
} from "./messaging";
export { preferenceComponent } from "./preference";
export { bulkheadComponent, circuitBreakerComponent } from "./resilience";
export { telemetryComponent } from "./telemetry";

export type {
  AdapterOptions,
  BulkheadComponentOptions,
  BulkheadLike,
  CircuitBreakerComponentOptions,
  CircuitBreakerLike,
  CircuitBreakerState,
  DatabaseComponentOptions,
  DatabaseLike,
  DynamicConfigLike,
  HttpServerComponentOptions,
  HttpServerLike,
  MessageBusLike,
  PreferenceLike,
  PoolLike,
  StartStopLike,
  TelemetryLike,
} from "./types";

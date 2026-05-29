/**
 * `forge/lifecycle/health` — liveness/readiness probes and their HTTP exposure.
 *
 * Compose a {@link Probe} from your components' `healthcheck`s with
 * {@link createProbe}, then expose it either as a standalone server
 * ({@link startHealthServer}, its own port) or by mounting {@link healthRoutes}
 * on an existing `forge/http` router. Liveness is cheap and never calls
 * downstreams; readiness aggregates every check worst-of and gates traffic
 * during startup/shutdown (spec §5).
 *
 * @example Standalone server
 * ```ts
 * import { createProbe, startHealthServer } from "forge/lifecycle/health";
 *
 * const probe = createProbe({
 *   ready: () => app.ready,
 *   checks: [{ name: "db", check: () => db.healthcheck() }],
 * });
 * const server = startHealthServer(probe, { port: 9000 });
 * // …later: server.stop();
 * ```
 *
 * @module
 */

export { createProbe } from "./probe";
export { healthRoutes, jsonResponse } from "./routes";
export { startHealthServer } from "./server";
export type {
  AggregateHealth,
  HealthCheck,
  HealthRoutes,
  HealthRoutesOptions,
  HealthServer,
  HealthServerOptions,
  Probe,
  ProbeOptions,
} from "./types";

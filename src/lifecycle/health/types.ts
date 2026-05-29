/**
 * Health-probe contracts for `forge/lifecycle/health`.
 *
 * Two distinct questions, two distinct probes — the Kubernetes model.
 * **Liveness** ("is the process wedged?") is deliberately cheap and never calls
 * downstreams, so a dependency outage cannot make k8s *kill* the pod.
 * **Readiness** ("should I receive traffic?") aggregates every component's
 * `healthcheck()` plus the boot `ready` flag, so traffic is gated during
 * startup and shutdown.
 *
 * @module
 */

import type {
  Clock,
  HealthContext,
  HealthResult,
  HealthStatus,
  LifecycleTelemetry,
  Logger,
} from "../types";

/** The aggregate health of the application, returned by a {@link Probe}. */
export interface AggregateHealth {
  /** Worst-of every contributing check (a non-critical failure → `degraded`). */
  readonly status: HealthStatus;
  /** Per-check results, keyed by check name. Empty for a gated/short-circuit result. */
  readonly checks: Readonly<Record<string, HealthResult>>;
  /** Whether the app should receive traffic (boot ready-gate AND no critical failure). */
  readonly ready: boolean;
  /** Milliseconds since the probe was created. */
  readonly uptimeMs: number;
}

/** The probe surface: a cheap liveness signal and an aggregate readiness check. */
export interface Probe {
  /**
   * Readiness aggregate: runs every registered check (bounded) and folds them
   * worst-of together with the boot ready-gate. Returns not-ready (without
   * calling downstreams) while the gate is closed, i.e. during startup/shutdown.
   */
  check(): Promise<AggregateHealth>;
  /**
   * Liveness signal: deliberately cheap. Reflects only the liveness gate (a
   * fatal flag the app flips) and **never** calls downstream checks, so a
   * dependency outage cannot make an orchestrator kill the process.
   */
  liveness(): AggregateHealth;
}

/** A single named readiness check, optionally non-critical. */
export interface HealthCheck {
  /** Identifier used in the aggregate `checks` map and metric labels. */
  readonly name: string;
  /** The check itself — typically a component's `healthcheck`. */
  readonly check: (ctx: HealthContext) => Promise<HealthResult> | HealthResult;
  /**
   * When `false`, an `unhealthy` result degrades the aggregate but keeps it
   * *ready*; when `true` (default) an `unhealthy` result makes the app not-ready.
   */
  readonly critical?: boolean;
}

/** Options for {@link createProbe}. */
export interface ProbeOptions {
  /** Readiness checks (e.g. one per component that exposes `healthcheck`). */
  readonly checks?: readonly HealthCheck[];
  /**
   * Boot readiness gate. Readiness requires this to return `true`; while it
   * returns `false` (startup/shutdown) `check()` short-circuits to not-ready
   * without calling downstreams. Default `() => true`.
   */
  readonly ready?: () => boolean;
  /**
   * Liveness gate — return `false` when the process is wedged/fatal. Default
   * `() => true` (alive until the app says otherwise).
   */
  readonly live?: () => boolean;
  /** Clock backing `uptimeMs` and per-check timeouts. Default `realClock`. */
  readonly clock?: Clock;
  /** Per-check timeout budget, in ms. A check that overruns is `unhealthy`. Default 5_000. */
  readonly checkTimeout?: number;
  /** Opt-in logger (structural). */
  readonly logger?: Logger;
  /** Opt-in telemetry (emits `lifecycle.health.check.duration`). */
  readonly telemetry?: LifecycleTelemetry;
}

/** Options shared by {@link healthRoutes} and the standalone health server. */
export interface HealthRoutesOptions {
  /** Liveness route. Default `/livez`. */
  readonly livenessPath?: string;
  /** Readiness route. Default `/readyz`. */
  readonly readinessPath?: string;
}

/** A framework-agnostic pair of probe HTTP handlers. */
export interface HealthRoutes extends Required<HealthRoutesOptions> {
  /**
   * Handle a request: returns a `Response` for the liveness/readiness paths, or
   * `undefined` for anything else so a host router can fall through.
   */
  handle(request: Request): Promise<Response | undefined>;
}

/** Options for the standalone {@link startHealthServer}. */
export interface HealthServerOptions extends HealthRoutesOptions {
  /** Port for the standalone `Bun.serve`. Default 9000. */
  readonly port?: number;
  /** Hostname to bind. Default Bun's default (all interfaces). */
  readonly hostname?: string;
}

/** A running standalone health server. */
export interface HealthServer {
  /** The bound port. */
  readonly port: number;
  /** The base URL the server is listening on. */
  readonly url: string;
  /** Stop the server. Idempotent. */
  stop(): void;
}

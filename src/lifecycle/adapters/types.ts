/**
 * Structural seams for the official `forge/lifecycle/adapters`.
 *
 * The adapters wrap `forge/telemetry`, `forge/config`, `forge/preference`,
 * `forge/security`, `forge/data`, `forge/http`, `forge/messaging`, and
 * `forge/resilience` objects into {@link Component}s, but they do so
 * **without** hard-importing those modules. Each adapter is typed against the
 * minimal `*Like` interface describing only the methods it touches; the real
 * `Telemetry`, `DynamicConfigHandle`, `PreferencesHandle`, `KeyStore`, `Db`,
 * `Pool`, `HttpServer`, `MessageConsumer`, `OutboxRelay`, `Worker`,
 * `MessageBus`, `CircuitBreakerPolicy`, and `BulkheadPolicy` already satisfy
 * these structurally, so the adapters are drop-in with zero changes to the other
 * modules.
 *
 * @module
 */

import type { HealthContext, HealthResult } from "../types";

/** Options shared by every adapter. */
export interface AdapterOptions {
  /**
   * Override the derived `healthcheck`. When omitted, adapters that can derive a
   * sensible default (database ping, pool stats) do so; the rest contribute no
   * `healthcheck` seam.
   */
  readonly healthcheck?: (
    ctx: HealthContext,
  ) => Promise<HealthResult> | HealthResult;
}

/** The slice of `forge/telemetry`'s `Telemetry` handle the {@link telemetryComponent} uses. */
export interface TelemetryLike {
  /** Flush pending telemetry and release exporter resources. */
  shutdown(): Promise<void> | void;
}

/** The slice of `forge/config`'s dynamic config handle the {@link configComponent} uses. */
export interface DynamicConfigLike {
  /** Stop provider subscriptions and release dynamic config resources. */
  shutdown(): Promise<void> | void;
}

/** The slice of `forge/preference`'s preferences handle the {@link preferenceComponent} uses. */
export interface PreferenceLike {
  /** Flush pending writes, unsubscribe watchers, and release store resources. */
  shutdown(): Promise<void> | void;
}

/** Health shape exposed by `forge/security` JWKS key stores. */
export interface SecurityHealthLike {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly message?: string;
  readonly checkedAt?: Date;
}

/** The slice of `forge/security`'s JWKS key store the {@link securityComponent} uses. */
export interface SecurityLike {
  /** Report IdP/JWKS reachability. */
  health(): Promise<SecurityHealthLike> | SecurityHealthLike;
  /** Release security resource state when exposed by the concrete resource. */
  shutdown?(): Promise<void> | void;
}

/** Options for {@link securityComponent}. */
export interface SecurityComponentOptions extends AdapterOptions {
  /** Report an unhealthy security health result as `degraded`. Default `false`. */
  readonly degraded?: boolean;
}

/** The slice of `forge/data`'s `Db` the {@link databaseComponent} uses. */
export interface DatabaseLike {
  /** Round-trip the connection; rejects when the database is unreachable. */
  ping(): Promise<void> | void;
  /** Release all connections/pools. */
  shutdown(): Promise<void> | void;
}

/** Options for {@link databaseComponent}. */
export interface DatabaseComponentOptions extends AdapterOptions {
  /** Call `db.ping()` from `start()` to fail-fast on an unreachable DB. Default `true`. */
  readonly pingOnStart?: boolean;
}

/** The slice of `forge/data`'s `Pool` the {@link poolComponent} uses. */
export interface PoolLike {
  /** Stop handing out resources and await in-flight leases to return. */
  drain(): Promise<void> | void;
  /** Drain and dispose every pooled resource. */
  shutdown?(): Promise<void> | void;
  /** Live counts used to derive a `healthcheck`. */
  stats?(): { readonly draining: boolean; readonly active?: number; readonly idle?: number; readonly waiting?: number };
}

/** The slice of a `forge/http` `HttpServer` the {@link httpServerComponent} uses. */
export interface HttpServerLike {
  /** Stop the server; `true` closes active connections after the drain. */
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

/** Options for {@link httpServerComponent}. */
export interface HttpServerComponentOptions extends AdapterOptions {
  /** Pass to `server.stop()` — drain in-flight requests then close. Default `true`. */
  readonly closeActiveConnections?: boolean;
}

/** A background runner with symmetric `start`/`stop` (consumer/relay/worker). */
export interface StartStopLike {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** The slice of `forge/messaging`'s `MessageBus` the {@link messageBusComponent} uses. */
export interface MessageBusLike {
  /** Drain any in-flight publishes. */
  flush(): Promise<void> | void;
  /** Release transport resources. */
  shutdown(): Promise<void> | void;
}

/** Circuit-breaker states observed by {@link circuitBreakerComponent}. */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/** The slice of `forge/resilience`'s `CircuitBreakerPolicy` the adapter uses. */
export interface CircuitBreakerLike {
  /** Current breaker state. */
  readonly state: CircuitBreakerState;
}

/** Options for {@link circuitBreakerComponent}. */
export interface CircuitBreakerComponentOptions extends AdapterOptions {
  /** Report an open breaker as `degraded` instead of `unhealthy`. Default `false`. */
  readonly degraded?: boolean;
}

/** The slice of `forge/resilience`'s `BulkheadPolicy` the adapter uses. */
export interface BulkheadLike {
  /** Number of operations currently running. */
  readonly active: number;
  /** Number of callers currently waiting for a slot. */
  readonly queued: number;
}

/** Options for {@link bulkheadComponent}. */
export interface BulkheadComponentOptions extends AdapterOptions {
  /** Report queued callers as `unhealthy` instead of `degraded`. Default `false`. */
  readonly unhealthyAtSaturation?: boolean;
}

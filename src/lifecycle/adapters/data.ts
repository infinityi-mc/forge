/**
 * `forge/data` adapters — wrap a `Db` or a `Pool` into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component, HealthResult } from "../types";
import type {
  DatabaseComponentOptions,
  DatabaseLike,
  PoolLike,
  AdapterOptions,
} from "./types";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adapt a `forge/data` `Db` into a {@link Component}:
 * - `start()` → `db.ping()` (fail-fast on an unreachable database; disable with
 *   `pingOnStart: false`);
 * - `stop()` → `db.shutdown()`;
 * - `healthcheck()` → `db.ping()` mapped to `healthy` / `unhealthy`.
 *
 * @example
 * ```ts
 * import { databaseComponent } from "forge/lifecycle/adapters";
 * const components = [databaseComponent("db", db)];
 * ```
 */
export function databaseComponent(
  name: string,
  db: DatabaseLike,
  options: DatabaseComponentOptions = {},
): Component {
  const pingOnStart = options.pingOnStart ?? true;
  const healthcheck =
    options.healthcheck ??
    (async (): Promise<HealthResult> => {
      try {
        await db.ping();
        return { status: "healthy", data: { ping: "ok" } };
      } catch (error) {
        return { status: "unhealthy", detail: describe(error) };
      }
    });
  return asComponent(name, {
    ...(pingOnStart ? { start: () => db.ping() } : {}),
    stop: () => db.shutdown(),
    healthcheck,
  });
}

/**
 * Adapt a `forge/data` `Pool` into a {@link Component}:
 * - `stop()` → `pool.shutdown()` (falls back to `pool.drain()`), so in-flight
 *   leases return before the process exits;
 * - `healthcheck()` → derived from `pool.stats()` (`draining` ⇒ `unhealthy`).
 */
export function poolComponent(
  name: string,
  pool: PoolLike,
  options: AdapterOptions = {},
): Component {
  const healthcheck =
    options.healthcheck ??
    (pool.stats !== undefined
      ? (): HealthResult => {
          const stats = pool.stats!();
          return stats.draining
            ? { status: "unhealthy", detail: "pool is draining" }
            : {
                status: "healthy",
                data: {
                  active: stats.active,
                  idle: stats.idle,
                  waiting: stats.waiting,
                },
              };
        }
      : undefined);
  return asComponent(name, {
    stop: () => (pool.shutdown !== undefined ? pool.shutdown() : pool.drain()),
    ...(healthcheck !== undefined ? { healthcheck } : {}),
  });
}

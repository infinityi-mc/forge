/**
 * `forge/security` adapter — wrap a security key store into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component, HealthResult } from "../types";
import type { SecurityComponentOptions, SecurityLike } from "./types";

/**
 * Adapt a `forge/security` JWKS key store into a {@link Component}.
 * `healthcheck()` mirrors `security.health()` and `stop()` delegates to
 * `security.shutdown()` when the resource exposes one.
 */
export function securityComponent(
  name: string,
  security: SecurityLike,
  options: SecurityComponentOptions = {},
): Component {
  const healthcheck =
    options.healthcheck ??
    (async (): Promise<HealthResult> => {
      const result = await security.health();
      const status =
        result.status === "unhealthy" && options.degraded === true
          ? "degraded"
          : result.status;
      return {
        status,
        ...(result.message === undefined ? {} : { detail: result.message }),
        ...(result.checkedAt === undefined
          ? {}
          : { data: { checkedAt: result.checkedAt.toISOString() } }),
      };
    });

  return asComponent(name, {
    ...(security.shutdown === undefined
      ? {}
      : { stop: () => security.shutdown!() }),
    healthcheck,
  });
}

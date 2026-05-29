/**
 * `forge/http` adapter — wrap an `HttpServer` into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component } from "../types";
import type { HttpServerComponentOptions, HttpServerLike } from "./types";

/**
 * Adapt a `forge/http` `HttpServer` into a {@link Component}. `stop()` calls
 * `server.stop(true)` so in-flight requests drain before connections close;
 * combine with {@link BootOptions.preStopDelayMs} to let a load balancer notice
 * `/readyz` flip to `503` first.
 *
 * @example
 * ```ts
 * import { httpServerComponent } from "forge/lifecycle/adapters";
 * const components = [httpServerComponent("http", server)];
 * ```
 */
export function httpServerComponent(
  name: string,
  server: HttpServerLike,
  options: HttpServerComponentOptions = {},
): Component {
  const closeActiveConnections = options.closeActiveConnections ?? true;
  return asComponent(name, {
    stop: () => server.stop(closeActiveConnections),
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

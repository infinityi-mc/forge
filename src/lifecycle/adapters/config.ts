/**
 * `forge/config` adapter — wrap a dynamic config handle into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component } from "../types";
import type { AdapterOptions, DynamicConfigLike } from "./types";

/**
 * Adapt a `forge/config` dynamic config handle into a {@link Component}.
 * `stop()` calls `dynamicConfig.shutdown()` to unsubscribe from provider
 * updates and release provider resources.
 */
export function configComponent(
  name: string,
  dynamicConfig: DynamicConfigLike,
  options: AdapterOptions = {},
): Component {
  return asComponent(name, {
    stop: () => dynamicConfig.shutdown(),
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

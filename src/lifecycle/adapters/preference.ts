/**
 * `forge/preference` adapter — wrap a preferences handle into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component } from "../types";
import type { AdapterOptions, PreferenceLike } from "./types";

/**
 * Adapt a `forge/preference` preferences handle into a {@link Component}.
 * `stop()` calls `prefs.shutdown()` to flush pending writes, unsubscribe
 * watchers, and release store resources.
 */
export function preferenceComponent(
  name: string,
  prefs: PreferenceLike,
  options: AdapterOptions = {},
): Component {
  return asComponent(name, {
    stop: () => prefs.shutdown(),
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

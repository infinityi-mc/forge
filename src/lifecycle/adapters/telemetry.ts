/**
 * `forge/telemetry` adapter — wrap a `Telemetry` handle into a {@link Component}.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component } from "../types";
import type { AdapterOptions, TelemetryLike } from "./types";

/**
 * Adapt a `forge/telemetry` `Telemetry` handle into a {@link Component}.
 * `stop()` calls `telemetry.shutdown()`, which flushes pending telemetry and
 * releases exporter resources.
 */
export function telemetryComponent(
  name: string,
  telemetry: TelemetryLike,
  options: AdapterOptions = {},
): Component {
  return asComponent(name, {
    stop: () => telemetry.shutdown(),
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

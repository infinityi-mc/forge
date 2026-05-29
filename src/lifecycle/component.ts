/**
 * `asComponent()` — adapt any object into a {@link Component}.
 *
 * Most Forge objects already satisfy {@link Component} structurally, but some
 * expose differently-named methods (e.g. `db.shutdown` instead of `stop`).
 * `asComponent` wraps a plain hook bag under an explicit `name`, mapping those
 * hooks onto the `start`/`stop`/`healthcheck` seam without forcing a base class.
 *
 * @example
 * ```ts
 * import { asComponent } from "forge/lifecycle";
 *
 * const db = asComponent("db", {
 *   start: () => pool.ping(),
 *   stop: () => pool.shutdown(),
 *   healthcheck: async () => ({ status: "healthy" }),
 * });
 * ```
 *
 * @module
 */

import { ComponentRegistrationError } from "./errors";
import type { Component, HealthContext, HealthResult, LifecycleContext } from "./types";

/** The lifecycle hooks {@link asComponent} maps onto a {@link Component}. */
export interface ComponentHooks {
  start?(ctx: LifecycleContext): Promise<void> | void;
  stop?(ctx: LifecycleContext): Promise<void> | void;
  healthcheck?(ctx: HealthContext): Promise<HealthResult> | HealthResult;
}

/**
 * Wrap a set of lifecycle hooks under a name to produce a {@link Component}.
 * Only the hooks you provide are attached, so the result contributes exactly
 * the seams it implements.
 *
 * @throws {ComponentRegistrationError} if `name` is empty or blank.
 */
export function asComponent(name: string, hooks: ComponentHooks = {}): Component {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ComponentRegistrationError(
      "asComponent: a non-empty component name is required",
    );
  }
  const component: { -readonly [K in keyof Component]: Component[K] } = { name };
  if (hooks.start) component.start = hooks.start;
  if (hooks.stop) component.stop = hooks.stop;
  if (hooks.healthcheck) component.healthcheck = hooks.healthcheck;
  return component;
}

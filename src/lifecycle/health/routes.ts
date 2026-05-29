/**
 * `healthRoutes` — framework-agnostic liveness/readiness HTTP handlers.
 *
 * Returns a `handle(request)` that answers the configured liveness/readiness
 * paths with a k8s-shaped response (`200` healthy/ready, `503` otherwise, JSON
 * {@link AggregateHealth} body) and `undefined` for anything else so a host
 * router (`forge/http`) can fall through. The standalone {@link startHealthServer}
 * reuses this so the two exposures share identical semantics.
 *
 * @module
 */

import type { AggregateHealth, HealthRoutes, HealthRoutesOptions, Probe } from "./types";

const DEFAULT_LIVENESS_PATH = "/livez";
const DEFAULT_READINESS_PATH = "/readyz";

/** Build the liveness/readiness handlers for a {@link Probe}. */
export function healthRoutes(
  probe: Probe,
  options: HealthRoutesOptions = {},
): HealthRoutes {
  const livenessPath = options.livenessPath ?? DEFAULT_LIVENESS_PATH;
  const readinessPath = options.readinessPath ?? DEFAULT_READINESS_PATH;

  async function handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === livenessPath) {
      const health = probe.liveness();
      return jsonResponse(health, health.status === "healthy" ? 200 : 503);
    }
    if (path === readinessPath) {
      const health = await probe.check();
      return jsonResponse(health, health.ready ? 200 : 503);
    }
    return undefined;
  }

  return { livenessPath, readinessPath, handle };
}

/** Serialize an {@link AggregateHealth} to a JSON `Response` with `status`. */
export function jsonResponse(health: AggregateHealth, status: number): Response {
  return new Response(JSON.stringify(health), {
    status,
    headers: { "content-type": "application/json" },
  });
}

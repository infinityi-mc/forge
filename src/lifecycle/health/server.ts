/**
 * `startHealthServer` — a standalone `Bun.serve` exposing the probe.
 *
 * Runs on its own port (default 9000), isolated from app traffic — the favoured
 * k8s shape. It mounts {@link healthRoutes} for `/livez` + `/readyz` and answers
 * everything else with `404`. Returns a handle whose `stop()` shuts the server
 * down (idempotent), so {@link boot} can tear it down at the end of shutdown.
 *
 * For the no-extra-port path, mount {@link healthRoutes} on an existing
 * `forge/http` router instead of starting this server.
 *
 * @module
 */

import { healthRoutes } from "./routes";
import type { HealthServer, HealthServerOptions, Probe } from "./types";

const DEFAULT_PORT = 9000;

/** Start a standalone health server for `probe`. */
export function startHealthServer(
  probe: Probe,
  options: HealthServerOptions = {},
): HealthServer {
  const routes = healthRoutes(probe, options);
  const server = Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    async fetch(request) {
      const response = await routes.handle(request);
      return response ?? new Response("not found", { status: 404 });
    },
  });

  let stopped = false;
  return {
    port: server.port ?? options.port ?? DEFAULT_PORT,
    url: server.url.href,
    stop() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
    },
  };
}

/**
 * {@link serve} — hand a {@link Router} to `Bun.serve()`.
 *
 * A thin adapter: it builds the router's folded {@link Handler} once, then
 * each inbound native `Request` becomes an {@link HttpRequest} (with the
 * request's own `AbortSignal`, which Bun fires on client disconnect) and is
 * dispatched. `stop()` mirrors the spec / `forge/lifecycle` shape: a graceful
 * drain by default, or a forced close of in-flight connections.
 *
 * @module
 */

import { createHttpRequest } from "./request";
import type { HttpServer, Router, ServeOptions } from "./types";

/** Minimal slice of Bun's server handle we rely on. */
interface BunServer {
  readonly port: number;
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

interface BunServeInit {
  port?: number;
  hostname?: string;
  unix?: string;
  fetch(request: Request): Promise<Response> | Response;
}

type BunServe = (init: BunServeInit) => BunServer;

/** Start a server for `router`. */
export function serve(router: Router, options: ServeOptions = {}): HttpServer {
  const handler = router.handler();
  const bunServe = (globalThis as unknown as { Bun?: { serve: BunServe } }).Bun
    ?.serve;
  if (typeof bunServe !== "function") {
    throw new Error("serve() requires the Bun runtime (Bun.serve is unavailable)");
  }

  const server = bunServe({
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    ...(options.unix !== undefined ? { unix: options.unix } : {}),
    fetch(request) {
      return handler(createHttpRequest(request));
    },
  });

  let stopped = false;
  return {
    port: server.port,
    url: server.url.href,
    async stop(closeActiveConnections = false) {
      if (stopped) return;
      stopped = true;
      await server.stop(closeActiveConnections);
    },
  };
}

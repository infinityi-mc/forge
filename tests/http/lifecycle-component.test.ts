import { describe, expect, test } from "bun:test";
import { createRouter, serve } from "../../src/http/server";
import { httpServerComponent } from "../../src/lifecycle/adapters";

/**
 * PR C lifecycle integration: an `HttpServer` from `serve()` already satisfies
 * `forge/lifecycle`'s structural `HttpServerLike`, so `httpServerComponent`
 * drives its graceful `stop()` with zero `forge/http` changes.
 */
describe("HttpServer ↔ forge/lifecycle", () => {
  test("httpServerComponent stop() drains a live server", async () => {
    const router = createRouter().get("/healthz", () => new Response("ok"));
    const server = serve(router, { port: 0 });

    const live = await fetch(`${server.url}healthz`);
    expect(await live.text()).toBe("ok");

    const component = httpServerComponent("http", server);
    expect(component.name).toBe("http");
    await component.stop?.({
      signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(fetch(`${server.url}healthz`)).rejects.toThrow();
  });

  test("stop() is idempotent", async () => {
    const server = serve(createRouter().get("/", () => new Response("ok")), { port: 0 });
    await server.stop(true);
    await expect(server.stop(true)).resolves.toBeUndefined();
  });
});

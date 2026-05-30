import { afterEach, describe, expect, test } from "bun:test";
import { createRouter, serve } from "../../src/http/server";
import { requestId, problemDetails } from "../../src/http/middleware";
import { problem } from "../../src/http/problem";
import type { HttpServer } from "../../src/http/server/types";

const servers: HttpServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop(true);
});

function start(router: ReturnType<typeof createRouter>): HttpServer {
  const server = serve(router, { port: 0 });
  servers.push(server);
  return server;
}

describe("serve", () => {
  test("serves routes over a real socket with params + status", async () => {
    const router = createRouter()
      .use(requestId({ generate: () => "fixed" }))
      .get("/health", () => new Response("ok"))
      .get("/echo/:msg", (req) => Response.json({ msg: req.params.msg }));
    const server = start(router);

    const health = await fetch(`${server.url}health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("fixed");

    const echo = await fetch(`${server.url}echo/hi`);
    expect(await echo.json()).toEqual({ msg: "hi" });
  });

  test("renders RFC 7807 problems end-to-end", async () => {
    const router = createRouter()
      .use(problemDetails())
      .get("/boom", () => {
        throw problem.forbidden("nope");
      });
    const server = start(router);
    const res = await fetch(`${server.url}boom`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  test("stop() drains in-flight requests and is idempotent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = createRouter().get("/slow", async () => {
      await gate;
      return new Response("drained");
    });
    const server = start(router);

    // Start an in-flight request, let it reach the handler, then stop().
    const inflight = fetch(`${server.url}slow`);
    await Bun.sleep(20);
    const stopping = server.stop(); // graceful: should wait for /slow
    release();
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("drained");

    await stopping;
    await server.stop(); // idempotent — must not throw
  });
});

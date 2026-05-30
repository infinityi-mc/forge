import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { testClient } from "../../src/http/testing";
import { RouteConflictError } from "../../src/http/errors";
import type { HttpRequest } from "../../src/http/types";

describe("createRouter — matching", () => {
  test("dispatches by method and path, exposing params", async () => {
    const router = createRouter()
      .get("/users/:id", (req) => Response.json({ id: req.params.id }))
      .post("/users", () => new Response("created", { status: 201 }));
    const client = testClient(router);

    const got = await client.get("/users/42");
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ id: "42" });

    const made = await client.post("/users");
    expect(made.status).toBe(201);
  });

  test("static segments beat params at the same position", async () => {
    const router = createRouter()
      .get("/files/:name", () => new Response("param"))
      .get("/files/latest", () => new Response("static"));
    const client = testClient(router);

    expect(await (await client.get("/files/latest")).text()).toBe("static");
    expect(await (await client.get("/files/report.pdf")).text()).toBe("param");
  });

  test("trailing wildcard captures the remainder", async () => {
    const router = createRouter().get("/assets/*path", (req) =>
      Response.json({ path: req.params.path }),
    );
    const res = await testClient(router).get("/assets/css/app.css");
    expect(await res.json()).toEqual({ path: "css/app.css" });
  });

  test("decodes percent-encoded params", async () => {
    const router = createRouter().get("/tags/:tag", (req) =>
      Response.json({ tag: req.params.tag }),
    );
    const res = await testClient(router).get("/tags/c%2B%2B");
    expect(await res.json()).toEqual({ tag: "c++" });
  });

  test("unmatched path is 404; matched path with wrong method is 405 + Allow", async () => {
    const router = createRouter()
      .get("/orders/:id", () => new Response("ok"))
      .put("/orders/:id", () => new Response("ok"));
    const client = testClient(router);

    const missing = await client.get("/nope");
    expect(missing.status).toBe(404);

    const wrong = await client.delete("/orders/1");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, PUT");
  });

  test("root path matches", async () => {
    const router = createRouter().get("/", () => new Response("home"));
    expect(await (await testClient(router).get("/")).text()).toBe("home");
  });

  test("custom notFound handler is used", async () => {
    const router = createRouter({
      notFound: () => new Response("custom", { status: 404 }),
    }).get("/known", () => new Response("ok"));
    const res = await testClient(router).get("/unknown");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom");
  });
});

describe("createRouter — fail-fast conflicts", () => {
  test("duplicate method+pattern throws at registration", () => {
    expect(() =>
      createRouter()
        .get("/dupe", () => new Response("a"))
        .get("/dupe", () => new Response("b")),
    ).toThrow(RouteConflictError);
  });

  test("conflicting param names at the same position throw", () => {
    expect(() =>
      createRouter()
        .get("/users/:id", () => new Response("a"))
        .get("/users/:slug/profile", () => new Response("b")),
    ).toThrow(RouteConflictError);
  });

  test("a route must end with a handler function", () => {
    // @ts-expect-error — intentionally wrong arity for the runtime guard.
    expect(() => createRouter().get("/x")).toThrow(RouteConflictError);
  });
});

describe("createRouter — middleware & mounting", () => {
  test("route-scoped middleware runs only for its route", async () => {
    const seen: string[] = [];
    const tap = (next: (req: HttpRequest) => Response | Promise<Response>) => (req: HttpRequest) => {
      seen.push(req.url.pathname);
      return next(req);
    };
    const router = createRouter()
      .get("/guarded", tap, () => new Response("ok"))
      .get("/open", () => new Response("ok"));
    const client = testClient(router);

    await client.get("/open");
    expect(seen).toEqual([]);
    await client.get("/guarded");
    expect(seen).toEqual(["/guarded"]);
  });

  test("router-wide use middleware wraps every route, outermost-first", async () => {
    const order: string[] = [];
    const mw = (label: string) =>
      (next: (req: HttpRequest) => Response | Promise<Response>) =>
      async (req: HttpRequest) => {
        order.push(label);
        return next(req);
      };
    const router = createRouter()
      .use(mw("a"))
      .use(mw("b"))
      .get("/", () => new Response("ok"));
    await testClient(router).get("/");
    expect(order).toEqual(["a", "b"]);
  });

  test("mount nests a sub-router under a prefix, preserving its middleware", async () => {
    const calls: string[] = [];
    const sub = createRouter()
      .use((next) => (req) => {
        calls.push("sub");
        return next(req);
      })
      .get("/:id", (req) => Response.json({ id: req.params.id }));
    const root = createRouter().mount("/api/v1/widgets", sub);

    const res = await testClient(root).get("/api/v1/widgets/7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "7" });
    expect(calls).toEqual(["sub"]);
  });

  test("locals.route exposes the matched pattern", async () => {
    let route: unknown;
    const router = createRouter().get("/teams/:team/members/:user", (req) => {
      route = req.locals.route;
      return new Response("ok");
    });
    await testClient(router).get("/teams/eng/members/ada");
    expect(route).toBe("/teams/:team/members/:user");
  });
});

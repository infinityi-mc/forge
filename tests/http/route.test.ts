import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { problemDetails } from "../../src/http/middleware";
import { testClient } from "../../src/http/testing";
import { objectSchema } from "./_helpers";

describe("router.route() — typed routes", () => {
  test("validates request and exposes typed locals to the handler", async () => {
    const router = createRouter().route({
      method: "POST",
      path: "/orders",
      request: { body: objectSchema<{ sku: string; qty: number }>({ sku: "string", qty: "number" }) },
      handler: (req) => Response.json({ sku: req.locals.body.sku, qty: req.locals.body.qty }),
    });
    const res = await testClient(router).post("/orders", { sku: "abc", qty: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sku: "abc", qty: 2 });
  });

  test("a bad body is rejected before the handler runs (422)", async () => {
    let handlerRan = false;
    const router = createRouter()
      .use(problemDetails())
      .route({
        method: "POST",
        path: "/orders",
        request: { body: objectSchema<{ qty: number }>({ qty: "number" }) },
        handler: () => {
          handlerRan = true;
          return new Response("ok");
        },
      });
    const res = await testClient(router).post("/orders", { qty: "bad" });
    expect(res.status).toBe(422);
    expect(handlerRan).toBe(false);
  });

  test("route-scoped middleware runs after validate, before the handler", async () => {
    const order: string[] = [];
    const router = createRouter().route({
      method: "GET",
      path: "/users/:id",
      request: { params: objectSchema<{ id: string }>({ id: "string" }) },
      middleware: [
        (next) => (req) => {
          order.push("mw");
          return next(req);
        },
      ],
      handler: (req) => {
        order.push("handler");
        return Response.json({ id: req.locals.params.id });
      },
    });
    const res = await testClient(router).get("/users/7");
    expect(await res.json()).toEqual({ id: "7" });
    expect(order).toEqual(["mw", "handler"]);
  });

  test("works without a request schema (plain typed route)", async () => {
    const router = createRouter().route({
      method: "GET",
      path: "/health",
      handler: () => new Response("ok"),
    });
    expect(await (await testClient(router).get("/health")).text()).toBe("ok");
  });
});

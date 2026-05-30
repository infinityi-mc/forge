import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { buildOpenApi, serveOpenApi, problemSchema } from "../../src/http/openapi";
import { testClient } from "../../src/http/testing";
import { OpenApiError } from "../../src/http/errors";
import { objectSchema } from "./_helpers";

function sampleRouter() {
  return createRouter()
    .route({
      method: "POST",
      path: "/orders",
      summary: "Create an order",
      tags: ["orders"],
      operationId: "createOrder",
      request: { body: objectSchema<{ sku: string; qty: number }>({ sku: "string", qty: "number" }) },
      responses: {
        201: { description: "Created", body: objectSchema<{ id: string }>({ id: "string" }) },
        422: problemSchema(),
      },
      handler: (req) => Response.json({ id: req.locals.body.sku }, { status: 201 }),
    })
    .route({
      method: "GET",
      path: "/orders/:id",
      request: {
        params: objectSchema<{ id: string }>({ id: "string" }),
        query: objectSchema<{ page: number }>({ page: "number" }),
      },
      handler: (req) => Response.json({ id: req.locals.params.id }),
    });
}

describe("buildOpenApi", () => {
  test("emits a 3.1 document with info and grouped paths", () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "Orders API", version: "1.2.3" } });
    expect(doc["openapi"]).toBe("3.1.0");
    expect(doc["info"]).toEqual({ title: "Orders API", version: "1.2.3" });
    const paths = doc["paths"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).sort()).toEqual(["/orders", "/orders/{id}"]);
  });

  test("requestBody schema is the same schema used to validate (single source of truth)", () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "T", version: "1" } });
    const op = (doc["paths"] as any)["/orders"]["post"];
    expect(op["summary"]).toBe("Create an order");
    expect(op["operationId"]).toBe("createOrder");
    expect(op["tags"]).toEqual(["orders"]);
    expect(op["requestBody"]["content"]["application/json"]["schema"]).toEqual({
      type: "object",
      properties: { sku: { type: "string" }, qty: { type: "number" } },
      required: ["sku", "qty"],
    });
  });

  test("path params and query params are derived from the route", () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "T", version: "1" } });
    const op = (doc["paths"] as any)["/orders/{id}"]["get"];
    const params = op["parameters"] as { name: string; in: string; required: boolean }[];
    const id = params.find((p) => p.name === "id");
    const page = params.find((p) => p.name === "page");
    expect(id).toMatchObject({ in: "path", required: true });
    expect(page).toMatchObject({ in: "query", required: true });
  });

  test("documents responses, incl. RFC 7807 problem media type", () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "T", version: "1" } });
    const responses = (doc["paths"] as any)["/orders"]["post"]["responses"];
    expect(responses["201"]["content"]["application/json"]).toBeDefined();
    expect(responses["422"]["content"]["application/problem+json"]["schema"]["required"]).toEqual([
      "type",
      "title",
      "status",
    ]);
  });

  test("defaults to a 200 response when none are declared", () => {
    const router = createRouter().route({ method: "GET", path: "/ping", handler: () => new Response("ok") });
    const doc = buildOpenApi(router, { info: { title: "T", version: "1" } });
    expect((doc["paths"] as any)["/ping"]["get"]["responses"]["200"]["description"]).toBeDefined();
  });

  test("includes servers when provided", () => {
    const doc = buildOpenApi(sampleRouter(), {
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
    });
    expect(doc["servers"]).toEqual([{ url: "https://api.example.com" }]);
  });

  test("re-homes mounted routes under their prefix", () => {
    const sub = createRouter().route({ method: "GET", path: "/:id", handler: () => new Response("ok") });
    const root = createRouter().mount("/users", sub);
    const doc = buildOpenApi(root, { info: { title: "T", version: "1" } });
    expect(Object.keys(doc["paths"] as object)).toEqual(["/users/{id}"]);
  });

  test("throws OpenApiError on missing info", () => {
    expect(() => buildOpenApi(sampleRouter(), { info: { title: "", version: "1" } })).toThrow(OpenApiError);
  });
});

describe("serveOpenApi", () => {
  test("serves the document as JSON at the default path", async () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "T", version: "1" } });
    const router = sampleRouter().use(serveOpenApi({ doc }));
    const res = await testClient(router).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as Record<string, unknown>)["openapi"]).toBe("3.1.0");
  });

  test("delegates non-matching paths to the router", async () => {
    const doc = buildOpenApi(sampleRouter(), { info: { title: "T", version: "1" } });
    const router = sampleRouter().use(serveOpenApi({ doc, path: "/spec.json" }));
    const res = await testClient(router).get("/orders/5?page=1");
    expect(await res.json()).toEqual({ id: "5" });
  });
});

import { describe, expect, test } from "bun:test";
import { createRouter } from "../../src/http/server";
import { validate, problemDetails } from "../../src/http/middleware";
import { testClient } from "../../src/http/testing";
import { ValidationError } from "../../src/http/errors";
import { objectSchema } from "./_helpers";

describe("validate() — body", () => {
  test("populates typed locals on success", async () => {
    const router = createRouter().post(
      "/orders",
      validate({ body: objectSchema<{ sku: string; qty: number }>({ sku: "string", qty: "number" }) }),
      (req) => Response.json(req.locals.body),
    );
    const res = await testClient(router).post("/orders", { sku: "abc", qty: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sku: "abc", qty: 3 });
  });

  test("throws ValidationError with .errors on a bad body", async () => {
    const schema = objectSchema<{ sku: string; qty: number }>({ sku: "string", qty: "number" });
    const mw = validate({ body: schema });
    const handler = mw(() => new Response("unreached"));
    const req = {
      json: () => Promise.resolve({ sku: 123, qty: "nope" }),
      locals: {} as Record<string, unknown>,
      params: {},
      query: new URLSearchParams(),
    } as unknown as Parameters<typeof handler>[0];

    let caught: unknown;
    try {
      await handler(req);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).errors).toEqual([
      { path: ["sku"], message: "expected string" },
      { path: ["qty"], message: "expected number" },
    ]);
  });

  test("malformed JSON body → ValidationError (422 via problemDetails)", async () => {
    const router = createRouter()
      .use(problemDetails())
      .post(
        "/orders",
        validate({ body: objectSchema<{ sku: string }>({ sku: "string" }) }),
        () => new Response("ok"),
      );
    const res = await testClient(router).post("/orders", undefined, {
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("validate() — query and params", () => {
  test("validates query into typed locals", async () => {
    const router = createRouter().get(
      "/search",
      validate({ query: objectSchema<{ page: number }>({ page: "number" }) }),
      (req) => Response.json(req.locals.query),
    );
    const res = await testClient(router).get("/search?page=2");
    expect(await res.json()).toEqual({ page: 2 });
  });

  test("validates path params into typed locals", async () => {
    const router = createRouter().get(
      "/users/:id",
      validate({ params: objectSchema<{ id: string }>({ id: "string" }) }),
      (req) => Response.json(req.locals.params),
    );
    const res = await testClient(router).get("/users/42");
    expect(await res.json()).toEqual({ id: "42" });
  });
});

describe("validate() + problemDetails — 422 mapping", () => {
  test("renders RFC 7807 422 with errors extension", async () => {
    const router = createRouter()
      .use(problemDetails())
      .post(
        "/orders",
        validate({ body: objectSchema<{ qty: number }>({ qty: "number" }) }),
        () => new Response("ok"),
      );
    const res = await testClient(router).post("/orders", { qty: "bad" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number; errors: unknown };
    expect(body.status).toBe(422);
    expect(body.errors).toEqual([{ path: ["qty"], message: "expected number" }]);
  });
});

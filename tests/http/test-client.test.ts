import { describe, expect, test } from "bun:test";
import {
  assertServerConformance,
  STANDARD_SERVER_SCENARIOS,
  testClient,
} from "../../src/http/testing";
import { createRouter } from "../../src/http/server";

describe("testClient", () => {
  test("drives routes in-process with JSON helpers", async () => {
    const router = createRouter()
      .get("/items/:id", (req) => Response.json({ id: req.params.id }))
      .post("/items", async (req) => {
        const body = (await req.json()) as { name: string };
        return Response.json({ created: body.name }, { status: 201 });
      });
    const client = testClient(router);

    const got = await client.get("/items/9");
    expect(await got.json()).toEqual({ id: "9" });

    const made = await client.post("/items", { name: "widget" });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ created: "widget" });
  });

  test("forwards query strings and custom headers", async () => {
    const router = createRouter().get("/search", (req) =>
      Response.json({
        q: req.query.get("q"),
        auth: req.headers.get("authorization"),
      }),
    );
    const res = await testClient(router).get("/search?q=forge", {
      headers: { authorization: "Bearer t" },
    });
    expect(await res.json()).toEqual({ q: "forge", auth: "Bearer t" });
  });
});

describe("server conformance", () => {
  test("the stock createRouter satisfies STANDARD_SERVER_SCENARIOS", async () => {
    await assertServerConformance();
  });

  test("the suite has the documented coverage", () => {
    expect(STANDARD_SERVER_SCENARIOS.length).toBeGreaterThanOrEqual(4);
  });
});

import { describe, expect, test } from "bun:test";
import { createRouter, createHttpRequest } from "../../src/http/server";
import { problemDetails } from "../../src/http/middleware";
import { authenticate, authorizeRoute } from "../../src/security/http";
import { requireRole } from "../../src/security/authz";
import { TokenInvalidError } from "../../src/security/errors";
import { fakePrincipal, testVerifier } from "../../src/security/testing";

/**
 * Proves the security middleware is directly mountable into a `forge/http`
 * router (gap #1) and that its errors render as RFC 7807 401/403 via
 * `problemDetails()` (gap #2).
 */
describe("security mounts into forge/http", () => {
  const verifier = testVerifier({
    principalFor: (token) => {
      if (token === "admin") return fakePrincipal({ roles: ["admin"] });
      if (token === "user") return fakePrincipal({ roles: ["user"] });
      return new TokenInvalidError("bad token");
    },
  });

  const handler = createRouter()
    .use(problemDetails())
    .use(authenticate({ verifier }))
    .get(
      "/admin/users",
      authorizeRoute(requireRole("admin"), { action: "users:list" }),
      () => Response.json({ users: ["a", "b"] }),
    )
    .handler();

  async function call(token?: string): Promise<Response> {
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` };
    return handler(
      createHttpRequest(new Request("http://forge.test/admin/users", { headers })),
    );
  }

  test("401 when the bearer token is missing/invalid", async () => {
    const missing = await call();
    expect(missing.status).toBe(401);
    expect(missing.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const invalid = await call("nope");
    expect(invalid.status).toBe(401);
  });

  test("403 when the principal lacks the required role", async () => {
    const res = await call("user");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  test("200 when authenticated and authorized", async () => {
    const res = await call("admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: ["a", "b"] });
  });
});

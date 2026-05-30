import { describe, expect, test } from "bun:test";
import {
  AuthorizationError,
  TokenInvalidError,
  allow,
  authorizeRoute,
  deny,
  requireScope,
} from "../../src/security";
import { authenticate } from "../../src/security/http";
import { fakePrincipal, testVerifier } from "../../src/security/testing";
import type { SecurityHttpRequest } from "../../src/security/http";

describe("security HTTP middleware seam", () => {
  test("missing and malformed bearer tokens reject", async () => {
    const verifier = testVerifier();
    const middleware = authenticate({ verifier });

    await expect(middleware({}, () => undefined)).rejects.toThrow(
      TokenInvalidError,
    );
    await expect(
      middleware({ headers: { authorization: "Basic token" } }, () => undefined),
    ).rejects.toThrow(TokenInvalidError);
  });

  test("valid token attaches req.locals.principal", async () => {
    const principal = fakePrincipal({ subject: "user_2" });
    const req: SecurityHttpRequest = {
      headers: { authorization: "Bearer token" },
    };

    await authenticate({ verifier: testVerifier({ principalFor: principal }) })(
      req,
      () => undefined,
    );

    expect(req.locals?.principal).toBe(principal);
  });

  test("authorizeRoute allows and calls next on allow", async () => {
    let called = 0;
    const req: SecurityHttpRequest = {
      locals: {
        principal: fakePrincipal({ scopes: ["reports:read"] }),
      },
    };

    await authorizeRoute(requireScope("reports:read"))(req, () => {
      called++;
    });

    expect(called).toBe(1);
  });

  test("authorizeRoute throws AuthorizationError on deny or missing principal", async () => {
    const req: SecurityHttpRequest = {
      locals: { principal: fakePrincipal() },
    };

    await expect(authorizeRoute(deny("blocked"))(req, () => undefined)).rejects.toThrow(
      AuthorizationError,
    );
    await expect(authorizeRoute(allow)({}, () => undefined)).rejects.toThrow(
      AuthorizationError,
    );
  });

  test("custom principalKey, action, and async resource options work", async () => {
    const principal = fakePrincipal({ tenant: "tenant_1" });
    const req: SecurityHttpRequest = {
      headers: new Headers({ authorization: "Bearer token" }),
    };
    let called = 0;

    await authenticate({
      verifier: testVerifier({ principalFor: principal }),
      principalKey: "actor",
    })(req, () => undefined);

    await authorizeRoute(
      (ctx: { action?: string; resource?: { tenantId: string } }) => {
        expect(ctx.action).toBe("read");
        expect(ctx.resource?.tenantId).toBe("tenant_1");
        return { effect: "allow" };
      },
      {
        principalKey: "actor",
        action: "read",
        resource: async () => ({ tenantId: "tenant_1" }),
      },
    )(req, () => {
      called++;
    });

    expect(req.locals?.actor).toBe(principal);
    expect(called).toBe(1);
  });
});

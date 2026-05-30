import { describe, expect, test } from "bun:test";
import {
  AuthorizationError,
  TokenInvalidError,
  allow,
  authorizeRoute,
  createAuditRecorder,
  deny,
  memoryAuditSink,
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

  test("successful authentication records an audit event", async () => {
    const principal = fakePrincipal({ subject: "user_3" });
    const sink = memoryAuditSink();
    const audit = createAuditRecorder({
      sink,
      idGenerator: () => "audit_auth_success",
    });
    const req: SecurityHttpRequest = {
      headers: { authorization: "Bearer token" },
    };

    await authenticate({
      verifier: testVerifier({ principalFor: principal }),
      audit,
      auditContext: { request: { method: "GET", path: "/reports" } },
    })(req, () => undefined);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      id: "audit_auth_success",
      type: "authentication/success",
      outcome: "success",
      principal: {
        subject: "user_3",
        issuer: "https://issuer.test",
      },
      request: { method: "GET", path: "/reports" },
    });
    expect(JSON.stringify(sink.events[0])).not.toContain("Bearer");
    expect(JSON.stringify(sink.events[0])).not.toContain("token");
  });

  test("authentication failure records and rethrows the original error", async () => {
    const sink = memoryAuditSink();
    const audit = createAuditRecorder({
      sink,
      idGenerator: () => "audit_auth_failure",
    });
    const error = new TokenInvalidError("bad token");

    await expect(
      authenticate({
        verifier: testVerifier({ principalFor: () => error }),
        audit,
      })({ headers: { authorization: "Bearer token" } }, () => undefined),
    ).rejects.toBe(error);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      id: "audit_auth_failure",
      type: "authentication/failure",
      outcome: "failure",
      reason: "bad token",
    });
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

  test("authorizeRoute records allow, deny, and missing-principal audit events", async () => {
    const sink = memoryAuditSink();
    const audit = createAuditRecorder({
      sink,
      idGenerator: () => `audit_${sink.events.length + 1}`,
    });
    const req: SecurityHttpRequest = {
      locals: {
        principal: fakePrincipal({
          scopes: ["reports:read"],
          tenant: "tenant_1",
        }),
      },
    };

    await authorizeRoute(requireScope("reports:read"), {
      audit,
      action: "reports:read",
      resource: "report_1",
    })(req, () => undefined);

    await expect(
      authorizeRoute(deny("blocked"), {
        audit,
        action: "reports:write",
      })(req, () => undefined),
    ).rejects.toThrow(AuthorizationError);

    await expect(
      authorizeRoute(allow, {
        audit,
        action: "reports:read",
      })({}, () => undefined),
    ).rejects.toThrow(AuthorizationError);

    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]).toMatchObject({
      type: "authorization/allow",
      outcome: "allow",
      action: "reports:read",
      resource: "report_1",
      principal: {
        subject: "user_1",
        tenant: "tenant_1",
      },
    });
    expect(sink.events[1]).toMatchObject({
      type: "authorization/deny",
      outcome: "deny",
      action: "reports:write",
      reason: "blocked",
    });
    expect(sink.events[2]).toMatchObject({
      type: "authorization/deny",
      outcome: "deny",
      action: "reports:read",
      reason: "principal_required",
    });
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
    const sink = memoryAuditSink();
    const audit = createAuditRecorder({ sink });
    const req: SecurityHttpRequest = {
      headers: new Headers({ authorization: "Bearer token" }),
    };
    let called = 0;

    await authenticate({
      verifier: testVerifier({ principalFor: principal }),
      principalKey: "actor",
      audit,
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
        audit,
        auditContext: async () => ({
          resource: { type: "report", tenantId: "tenant_1" },
          attributes: { trace: "abc" },
        }),
      },
    )(req, () => {
      called++;
    });

    expect(req.locals?.actor).toBe(principal);
    expect(called).toBe(1);
    expect(sink.events.at(-1)).toMatchObject({
      type: "authorization/allow",
      outcome: "allow",
      action: "read",
      resource: { type: "report", tenantId: "tenant_1" },
      attributes: { trace: "abc" },
    });
  });

  test("audit failures do not replace auth flow outcomes", async () => {
    const audit = {
      async record() {
        throw new Error("audit down");
      },
    };
    const req: SecurityHttpRequest = {
      locals: { principal: fakePrincipal({ scopes: ["reports:read"] }) },
    };
    let called = 0;

    await authorizeRoute(requireScope("reports:read"), { audit })(req, () => {
      called++;
    });
    expect(called).toBe(1);

    const error = new TokenInvalidError("bad token");
    await expect(
      authenticate({
        verifier: testVerifier({ principalFor: () => error }),
        audit,
      })({ headers: { authorization: "Bearer token" } }, () => undefined),
    ).rejects.toBe(error);
  });
});

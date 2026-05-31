import { describe, expect, test } from "bun:test";
import {
  AuthorizationError,
  TokenInvalidError,
  allow,
  authorizeRoute,
  createAuditLogger,
  deny,
  memorySink,
  requireScope,
} from "../../src/security";
import { authenticate } from "../../src/security/http";
import { fakePrincipal, testVerifier } from "../../src/security/testing";
import type {
  SecurityHandler,
  SecurityHttpRequest,
} from "../../src/security/http";

const ok: SecurityHandler = () => new Response("ok");

describe("security HTTP middleware seam", () => {
  test("missing and malformed bearer tokens reject", async () => {
    const verifier = testVerifier();
    const middleware = authenticate({ verifier })(ok);

    await expect(middleware({ headers: new Headers() })).rejects.toThrow(
      TokenInvalidError,
    );
    await expect(
      middleware({ headers: { authorization: "Basic token" } }),
    ).rejects.toThrow(TokenInvalidError);
  });

  test("valid token attaches req.locals.principal and calls next", async () => {
    const principal = fakePrincipal({ subject: "user_2" });
    const req: SecurityHttpRequest = {
      headers: { authorization: "Bearer token" },
      locals: {},
    };

    const res = await authenticate({
      verifier: testVerifier({ principalFor: principal }),
    })(ok)(req);

    expect(req.locals?.principal).toBe(principal);
    expect(await res.text()).toBe("ok");
  });

  test("successful authentication records an audit event", async () => {
    const principal = fakePrincipal({ subject: "user_3" });
    const sink = memorySink();
    const audit = createAuditLogger({ sink });
    const req: SecurityHttpRequest = {
      headers: { authorization: "Bearer token" },
      locals: {},
    };

    await authenticate({
      verifier: testVerifier({ principalFor: principal }),
      audit,
      auditContext: { metadata: { method: "GET", path: "/reports" } },
    })(ok)(req);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      action: "auth.authenticated",
      outcome: "success",
      principal: { subject: "user_3", issuer: "https://issuer.test" },
      metadata: { method: "GET", path: "/reports" },
    });
    expect(JSON.stringify(sink.events[0])).not.toContain("Bearer");
  });

  test("authentication failure records and rethrows the original error", async () => {
    const sink = memorySink();
    const audit = createAuditLogger({ sink });
    const error = new TokenInvalidError("bad token");

    await expect(
      authenticate({
        verifier: testVerifier({ principalFor: () => error }),
        audit,
      })(ok)({ headers: { authorization: "Bearer token" } }),
    ).rejects.toBe(error);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      action: "auth.authentication_failed",
      outcome: "failure",
      reason: "bad token",
    });
  });

  test("authorizeRoute allows and calls next on allow", async () => {
    let called = 0;
    const req: SecurityHttpRequest = {
      headers: new Headers(),
      locals: { principal: fakePrincipal({ scopes: ["reports:read"] }) },
    };

    await authorizeRoute(requireScope("reports:read"))(() => {
      called++;
      return new Response("ok");
    })(req);

    expect(called).toBe(1);
  });

  test("authorizeRoute records allow, deny, and missing-principal audit events", async () => {
    const sink = memorySink();
    const audit = createAuditLogger({ sink });
    const req: SecurityHttpRequest = {
      headers: new Headers(),
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
    })(ok)(req);

    await expect(
      authorizeRoute(deny("blocked"), {
        audit,
        action: "reports:write",
      })(ok)(req),
    ).rejects.toThrow(AuthorizationError);

    await expect(
      authorizeRoute(allow, {
        audit,
        action: "reports:read",
      })(ok)({ headers: new Headers() }),
    ).rejects.toThrow(AuthorizationError);

    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]).toMatchObject({
      action: "authz.allowed",
      outcome: "success",
      metadata: { action: "reports:read" },
      principal: { subject: "user_1", tenant: "tenant_1" },
    });
    expect(sink.events[1]).toMatchObject({
      action: "authz.denied",
      outcome: "denied",
      metadata: { action: "reports:write" },
      reason: "blocked",
    });
    expect(sink.events[2]).toMatchObject({
      action: "authz.denied",
      outcome: "denied",
      metadata: { action: "reports:read" },
      reason: "principal_required",
    });
  });

  test("authorizeRoute throws AuthorizationError on deny or missing principal", async () => {
    const req: SecurityHttpRequest = {
      headers: new Headers(),
      locals: { principal: fakePrincipal() },
    };

    await expect(
      authorizeRoute(deny("blocked"))(ok)(req),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      authorizeRoute(allow)(ok)({ headers: new Headers() }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("authz decisions metric and spans are emitted when telemetry is wired", async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const spans: Array<{ name: string; status?: string; ended: boolean }> = [];
    const telemetry = {
      meter: {
        createCounter: () => ({
          add: (_value: number, attributes?: Record<string, unknown>) => {
            decisions.push(attributes ?? {});
          },
        }),
      },
      tracer: {
        startSpan: (name: string) => {
          const span = { name, ended: false } as {
            name: string;
            status?: string;
            ended: boolean;
          };
          spans.push(span);
          return {
            setAttribute: () => undefined,
            setStatus: (s: { code: string }) => {
              span.status = s.code;
            },
            end: () => {
              span.ended = true;
            },
          };
        },
      },
    };
    const req: SecurityHttpRequest = {
      headers: new Headers(),
      locals: { principal: fakePrincipal({ scopes: ["reports:read"] }) },
    };

    await authorizeRoute(requireScope("reports:read"), {
      action: "reports:read",
      telemetry,
    })(ok)(req);
    await expect(
      authorizeRoute(deny("blocked"), { action: "reports:write", telemetry })(
        ok,
      )(req),
    ).rejects.toThrow(AuthorizationError);

    expect(decisions).toEqual([
      { action: "reports:read", effect: "allow" },
      { action: "reports:write", effect: "deny" },
    ]);
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.ended)).toBe(true);
    expect(spans[1]?.status).toBe("error");
  });

  test("custom principalKey, action, and async resource options work", async () => {
    const principal = fakePrincipal({ tenant: "tenant_1" });
    const sink = memorySink();
    const audit = createAuditLogger({ sink });
    const req: SecurityHttpRequest = {
      headers: new Headers({ authorization: "Bearer token" }),
      locals: {},
    };
    let called = 0;

    await authenticate({
      verifier: testVerifier({ principalFor: principal }),
      principalKey: "actor",
      audit,
    })(ok)(req);

    await authorizeRoute<{ tenantId: string }>(
      (ctx) => {
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
          resource: { type: "report", id: "tenant_1" },
          metadata: { trace: "abc" },
        }),
      },
    )(() => {
      called++;
      return new Response("ok");
    })(req);

    expect(req.locals?.actor).toBe(principal);
    expect(called).toBe(1);
    expect(sink.events.at(-1)).toMatchObject({
      action: "authz.allowed",
      outcome: "success",
      resource: { type: "report", id: "tenant_1" },
      metadata: { action: "read", trace: "abc" },
    });
  });

  test("audit failures do not replace auth flow outcomes", async () => {
    const audit = {
      async record() {
        throw new Error("audit down");
      },
    };
    const req: SecurityHttpRequest = {
      headers: new Headers(),
      locals: { principal: fakePrincipal({ scopes: ["reports:read"] }) },
    };
    let called = 0;

    await authorizeRoute(requireScope("reports:read"), { audit })(() => {
      called++;
      return new Response("ok");
    })(req);
    expect(called).toBe(1);

    const error = new TokenInvalidError("bad token");
    await expect(
      authenticate({
        verifier: testVerifier({ principalFor: () => error }),
        audit,
      })(ok)({ headers: { authorization: "Bearer token" } }),
    ).rejects.toBe(error);
  });
});

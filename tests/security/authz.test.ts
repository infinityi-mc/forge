import { describe, expect, test } from "bun:test";
import {
  allow,
  allOf,
  anyOf,
  authorize,
  deny,
  not,
  requireRole,
  requireScope,
  requireTenant,
  type AuthzContext,
  type Policy,
} from "../../src/security/authz";
import { fakePrincipal } from "../../src/security/testing";

describe("authorization policies", () => {
  const ctx: AuthzContext = {
    action: "reports:read",
    principal: fakePrincipal({
      roles: ["admin"],
      scopes: ["reports:read"],
      tenant: "tenant_1",
    }),
  };

  test("role, scope, and tenant policies allow matching principals", async () => {
    await expect(authorize(requireRole("admin"), ctx)).resolves.toEqual({
      effect: "allow",
    });
    await expect(authorize(requireScope("reports:read"), ctx)).resolves.toEqual({
      effect: "allow",
    });
    await expect(
      authorize(requireTenant(() => "tenant_1"), ctx),
    ).resolves.toEqual({ effect: "allow" });
  });

  test("requireRole/requireScope are variadic (any-of)", async () => {
    await expect(
      authorize(requireRole("operator", "admin"), ctx),
    ).resolves.toEqual({ effect: "allow" });
    await expect(
      authorize(requireScope("reports:write", "reports:read"), ctx),
    ).resolves.toEqual({ effect: "allow" });
  });

  test("role, scope, and tenant policies deny missing grants", async () => {
    await expect(authorize(requireRole("operator"), ctx)).resolves.toEqual({
      effect: "deny",
      reason: "role_required",
    });
    await expect(authorize(requireScope("reports:write"), ctx)).resolves.toEqual({
      effect: "deny",
      reason: "scope_required",
    });
    await expect(
      authorize(requireTenant(() => "tenant_2"), ctx),
    ).resolves.toEqual({ effect: "deny", reason: "tenant_required" });
  });

  test("allOf short-circuits on the first deny", async () => {
    let called = 0;
    const afterDeny: Policy = () => {
      called++;
      return { effect: "allow" };
    };

    await expect(
      authorize(allOf(allow, deny("nope"), afterDeny), ctx),
    ).resolves.toEqual({ effect: "deny", reason: "nope" });
    expect(called).toBe(0);
  });

  test("anyOf short-circuits on the first allow", async () => {
    let called = 0;
    const afterAllow: Policy = () => {
      called++;
      return { effect: "deny", reason: "late" };
    };

    await expect(
      authorize(anyOf(deny("first"), allow, afterAllow), ctx),
    ).resolves.toEqual({ effect: "allow" });
    expect(called).toBe(0);
  });

  test("not inverts allow and deny decisions", async () => {
    await expect(authorize(not(allow), ctx)).resolves.toEqual({
      effect: "deny",
      reason: "not_allowed",
    });
    await expect(authorize(not(deny("blocked")), ctx)).resolves.toEqual({
      effect: "allow",
    });
  });

  test("policy throws and invalid decisions fail closed", async () => {
    await expect(
      authorize(() => {
        throw new Error("boom");
      }, ctx),
    ).resolves.toEqual({ effect: "deny", reason: "policy_error" });

    await expect(authorize((() => undefined) as any, ctx)).resolves.toEqual({
      effect: "deny",
      reason: "policy_error",
    });
    await expect(
      authorize((() => ({ effect: "maybe" })) as any, ctx),
    ).resolves.toEqual({ effect: "deny", reason: "policy_error" });
    // A deny with no string reason is not a valid Decision → fail closed.
    await expect(
      authorize((() => ({ effect: "deny" })) as any, ctx),
    ).resolves.toEqual({ effect: "deny", reason: "policy_error" });
  });

  test("tenant policy reads the tenant from a typed resource", async () => {
    interface Resource {
      readonly tenantId: string;
    }
    const resourceCtx: AuthzContext<Resource> = {
      action: "reports:read",
      principal: ctx.principal,
      resource: { tenantId: "tenant_1" },
    };

    await expect(
      authorize(
        requireTenant<Resource>((resource) => resource?.tenantId),
        resourceCtx,
      ),
    ).resolves.toEqual({ effect: "allow" });
  });
});

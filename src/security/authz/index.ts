import type { Principal } from "../types";

export type Decision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly reason: string };

export interface AuthzContext<R = unknown> {
  readonly principal: Principal;
  /** The action being guarded (handler-supplied, e.g. `"reports:read"`). */
  readonly action: string;
  readonly resource?: R;
}

export type Policy<R = unknown> =
  (ctx: AuthzContext<R>) => Decision | Promise<Decision>;

export async function authorize<R>(
  policy: Policy<R>,
  ctx: AuthzContext<R>,
): Promise<Decision> {
  try {
    const decision = await policy(ctx);
    return isDecision(decision) ? decision : denied("policy_error");
  } catch {
    return denied("policy_error");
  }
}

export const allow: Policy<any> = () => ({ effect: "allow" });

export function deny<R = unknown>(reason: string): Policy<R> {
  return () => denied(reason);
}

/** Allow when the principal holds **any** of the given roles. */
export function requireRole<R = unknown>(...roles: string[]): Policy<R> {
  return ({ principal }) =>
    roles.some((role) => principal.roles.includes(role))
      ? { effect: "allow" }
      : denied("role_required");
}

/** Allow when the principal holds **any** of the given scopes. */
export function requireScope<R = unknown>(...scopes: string[]): Policy<R> {
  return ({ principal }) =>
    scopes.some((scope) => principal.scopes.includes(scope))
      ? { effect: "allow" }
      : denied("scope_required");
}

/**
 * Allow when the principal's tenant matches the tenant extracted from the
 * guarded resource. Fail-closed when either side is absent.
 */
export function requireTenant<R = unknown>(
  tenantOf: (resource: R | undefined) => string | undefined,
): Policy<R> {
  return ({ principal, resource }) => {
    const expected = tenantOf(resource);
    return expected !== undefined && principal.tenant === expected
      ? { effect: "allow" }
      : denied("tenant_required");
  };
}

export function allOf<R = unknown>(
  ...policies: readonly Policy<R>[]
): Policy<R> {
  return async (ctx) => {
    for (const policy of policies) {
      const decision = await authorize(policy, ctx);
      if (decision.effect === "deny") return decision;
    }
    return { effect: "allow" };
  };
}

export function anyOf<R = unknown>(
  ...policies: readonly Policy<R>[]
): Policy<R> {
  return async (ctx) => {
    let lastDeny: Decision = denied("no_policy_allowed");
    for (const policy of policies) {
      const decision = await authorize(policy, ctx);
      if (decision.effect === "allow") return decision;
      lastDeny = decision;
    }
    return lastDeny;
  };
}

export function not<R = unknown>(policy: Policy<R>): Policy<R> {
  return async (ctx) => {
    const decision = await authorize(policy, ctx);
    return decision.effect === "allow" ? denied("not_allowed") : { effect: "allow" };
  };
}

function denied(reason: string): Decision {
  return { effect: "deny", reason };
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const effect = (value as { effect?: unknown }).effect;
  if (effect === "allow") return true;
  if (effect !== "deny") return false;
  return typeof (value as { reason?: unknown }).reason === "string";
}

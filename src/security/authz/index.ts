import type { Principal } from "../types";

export type Decision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly reason?: string };

export interface AuthzContext<R = unknown> {
  readonly principal: Principal;
  readonly action?: string;
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

export function deny<R = unknown>(reason?: string): Policy<R> {
  return () => denied(reason);
}

export function requireRole<R = unknown>(role: string): Policy<R> {
  return ({ principal }) =>
    principal.roles.includes(role) ? { effect: "allow" } : denied("role_required");
}

export function requireScope<R = unknown>(scope: string): Policy<R> {
  return ({ principal }) =>
    principal.scopes.includes(scope) ? { effect: "allow" } : denied("scope_required");
}

export function requireTenant<R = unknown>(
  tenant: string | ((ctx: AuthzContext<R>) => string | undefined),
): Policy<R> {
  return (ctx) => {
    const expected = typeof tenant === "function" ? tenant(ctx) : tenant;
    return expected !== undefined && ctx.principal.tenant === expected
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

function denied(reason?: string): Decision {
  return reason === undefined ? { effect: "deny" } : { effect: "deny", reason };
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const effect = (value as { effect?: unknown }).effect;
  if (effect === "allow") return true;
  if (effect !== "deny") return false;
  const reason = (value as { reason?: unknown }).reason;
  return reason === undefined || typeof reason === "string";
}

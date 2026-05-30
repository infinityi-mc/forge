import { AuthorizationError, TokenInvalidError } from "../errors";
import { authorize } from "../authz";
import type { AuthzContext, Policy } from "../authz";
import type { Principal, TokenVerifier } from "../types";

export interface SecurityHttpRequest {
  readonly headers?: HeadersLike;
  locals?: Record<PropertyKey, unknown>;
}

export type HeadersLike =
  | Headers
  | { get(name: string): string | null | undefined }
  | Record<string, string | readonly string[] | undefined>;

export type NextFunction = () => unknown | Promise<unknown>;

export interface AuthenticateOptions {
  readonly verifier: TokenVerifier;
  readonly principalKey?: PropertyKey;
}

export interface AuthorizeRouteOptions<R = unknown> {
  readonly action?: string;
  readonly resource?: R | ((req: SecurityHttpRequest) => R | Promise<R>);
  readonly principalKey?: PropertyKey;
}

export function authenticate(options: AuthenticateOptions) {
  const principalKey = options.principalKey ?? "principal";
  return async (req: SecurityHttpRequest, next: NextFunction) => {
    const token = bearerToken(req);
    const principal = await options.verifier.verify(token);
    req.locals ??= {};
    req.locals[principalKey] = principal;
    return next();
  };
}

export function authorizeRoute<R = unknown>(
  policy: Policy<R>,
  options: AuthorizeRouteOptions<R> = {},
) {
  const principalKey = options.principalKey ?? "principal";
  return async (req: SecurityHttpRequest, next: NextFunction) => {
    const principal = req.locals?.[principalKey];
    if (!isPrincipal(principal)) {
      throw new AuthorizationError("Principal is required");
    }

    const resource = typeof options.resource === "function"
      ? await (options.resource as (req: SecurityHttpRequest) => R | Promise<R>)(req)
      : options.resource;
    const ctx: AuthzContext<R> = {
      principal,
      ...(options.action === undefined ? {} : { action: options.action }),
      ...(resource === undefined ? {} : { resource }),
    };
    const decision = await authorize(policy, ctx);
    if (decision.effect === "deny") {
      throw new AuthorizationError(decision.reason ?? "Access denied");
    }
    return next();
  };
}

function bearerToken(req: SecurityHttpRequest): string {
  const authorization = headerValue(req.headers, "authorization");
  if (authorization === undefined) {
    throw new TokenInvalidError("Bearer token is required");
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === "") {
    throw new TokenInvalidError("Bearer token is malformed");
  }
  return match[1];
}

function headerValue(headers: HeadersLike | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { subject?: unknown }).subject === "string" &&
    typeof (value as { issuer?: unknown }).issuer === "string" &&
    Array.isArray((value as { audience?: unknown }).audience) &&
    Array.isArray((value as { roles?: unknown }).roles) &&
    Array.isArray((value as { scopes?: unknown }).scopes)
  );
}

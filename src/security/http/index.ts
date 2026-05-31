import { AuthorizationError, TokenInvalidError } from "../errors";
import { authorize } from "../authz";
import type { AuthzContext, Policy } from "../authz";
import { auditPrincipal } from "../audit";
import type { AuditEventInput, AuditRecorder, AuditResource } from "../audit";
import type { Principal, TokenVerifier } from "../types";

/**
 * Minimal structural view of the request the security middleware needs:
 * headers to read the bearer token and `locals` to attach the verified
 * {@link Principal}. `forge/http`'s `HttpRequest` satisfies this, so the
 * middleware mounts into a router without a hard dependency on `forge/http`.
 */
export interface SecurityHttpRequest {
  readonly headers: HeadersLike;
  locals?: Record<string, unknown>;
  /** Optional method/path, used only to derive a default authz `action`. */
  readonly method?: string;
  readonly url?: { readonly pathname: string };
}

export type HeadersLike =
  | Headers
  | { get(name: string): string | null | undefined }
  | Record<string, string | readonly string[] | undefined>;

/**
 * The `forge/http` handler/middleware shapes, expressed structurally so the
 * exported middleware is mountable via `router.use(...)` / route middleware
 * without importing `forge/http`. `Req` infers to the host's request type
 * (e.g. `HttpRequest`) at the call site.
 */
export type SecurityHandler<Req extends SecurityHttpRequest = SecurityHttpRequest> =
  (req: Req) => Response | Promise<Response>;

export type SecurityMiddleware<Req extends SecurityHttpRequest = SecurityHttpRequest> =
  (next: SecurityHandler<Req>) => SecurityHandler<Req>;

export type AuditHttpContext = Partial<
  Pick<AuditEventInput, "request" | "attributes" | "resource">
>;

export type AuditHttpContextProvider<Req extends SecurityHttpRequest = SecurityHttpRequest> =
  | AuditHttpContext
  | ((req: Req) => AuditHttpContext | Promise<AuditHttpContext>);

export interface AuthenticateOptions<Req extends SecurityHttpRequest = SecurityHttpRequest> {
  readonly verifier: TokenVerifier;
  readonly principalKey?: string;
  readonly audit?: AuditRecorder;
  readonly auditContext?: AuditHttpContextProvider<Req>;
}

export interface AuthorizeRouteOptions<
  R = unknown,
  Req extends SecurityHttpRequest = SecurityHttpRequest,
> {
  /** The action recorded/evaluated. Defaults to `"<METHOD> <path>"`. */
  readonly action?: string;
  readonly resource?: R | ((req: Req) => R | Promise<R>);
  readonly principalKey?: string;
  readonly audit?: AuditRecorder;
  readonly auditContext?: AuditHttpContextProvider<Req>;
}

/**
 * Verify the `Authorization: Bearer` token, attach the {@link Principal} to
 * `req.locals`, audit the outcome, and rethrow an {@link AuthenticationError}
 * (→ RFC 7807 `401` via `problemDetails()`) on failure.
 */
export function authenticate<Req extends SecurityHttpRequest = SecurityHttpRequest>(
  options: AuthenticateOptions<Req>,
): SecurityMiddleware<Req> {
  const principalKey = options.principalKey ?? "principal";
  return (next) => async (req) => {
    let principal: Principal;
    try {
      const token = bearerToken(req);
      principal = await options.verifier.verify(token);
      req.locals ??= {};
      req.locals[principalKey] = principal;
    } catch (error) {
      await recordAudit(req, options.audit, options.auditContext, {
        type: "authentication/failure",
        outcome: "failure",
        reason: reasonForError(error),
      });
      throw error;
    }
    await recordAudit(req, options.audit, options.auditContext, {
      type: "authentication/success",
      outcome: "success",
      principal: auditPrincipal(principal),
    });
    return next(req);
  };
}

/**
 * Evaluate `policy` against `req.locals.principal`, audit allow/deny, and
 * rethrow an {@link AuthorizationError} (→ RFC 7807 `403`) on deny.
 */
export function authorizeRoute<
  R = unknown,
  Req extends SecurityHttpRequest = SecurityHttpRequest,
>(
  policy: Policy<R>,
  options: AuthorizeRouteOptions<R, Req> = {},
): SecurityMiddleware<Req> {
  const principalKey = options.principalKey ?? "principal";
  return (next) => async (req) => {
    const action = options.action ?? deriveAction(req);
    const principal = req.locals?.[principalKey];
    if (!isPrincipal(principal)) {
      await recordAudit(req, options.audit, options.auditContext, {
        type: "authorization/deny",
        outcome: "deny",
        action,
        reason: "principal_required",
      });
      throw new AuthorizationError("Principal is required");
    }

    const resource = typeof options.resource === "function"
      ? await (options.resource as (req: Req) => R | Promise<R>)(req)
      : options.resource;
    const ctx: AuthzContext<R> = {
      principal,
      action,
      ...(resource === undefined ? {} : { resource }),
    };
    const decision = await authorize(policy, ctx);
    if (decision.effect === "deny") {
      await recordAudit(req, options.audit, options.auditContext, {
        type: "authorization/deny",
        outcome: "deny",
        principal: auditPrincipal(principal),
        action,
        ...auditResource(resource),
        reason: decision.reason,
      });
      throw new AuthorizationError(decision.reason);
    }
    await recordAudit(req, options.audit, options.auditContext, {
      type: "authorization/allow",
      outcome: "allow",
      principal: auditPrincipal(principal),
      action,
      ...auditResource(resource),
    });
    return next(req);
  };
}

function deriveAction(req: SecurityHttpRequest): string {
  if (req.method !== undefined && req.url !== undefined) {
    return `${req.method} ${req.url.pathname}`;
  }
  return req.method ?? "authorize";
}

async function recordAudit(
  req: SecurityHttpRequest,
  audit: AuditRecorder | undefined,
  provider: AuditHttpContextProvider<any> | undefined,
  event: AuditEventInput,
): Promise<void> {
  if (audit === undefined) return;
  try {
    const context = await auditContext(req, provider);
    await audit.record({ ...event, ...context });
  } catch {
    // Audit is best-effort and must not alter authentication/authorization flow.
  }
}

async function auditContext(
  req: SecurityHttpRequest,
  provider: AuditHttpContextProvider<any> | undefined,
): Promise<AuditHttpContext> {
  if (provider === undefined) return {};
  return typeof provider === "function" ? await provider(req) : provider;
}

function auditResource(resource: unknown): { resource?: AuditResource } {
  if (
    typeof resource === "string" ||
    typeof resource === "number" ||
    typeof resource === "boolean"
  ) {
    return { resource };
  }
  return {};
}

function reasonForError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "unknown";
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
    return value as string;
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

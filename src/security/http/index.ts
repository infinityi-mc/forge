import { AuthorizationError, TokenInvalidError } from "../errors";
import { authorize } from "../authz";
import type { AuthzContext, Policy } from "../authz";
import { auditPrincipal } from "../audit";
import type { AuditEventInput, AuditRecorder, AuditResource } from "../audit";
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

export type AuditHttpContext = Partial<
  Pick<AuditEventInput, "request" | "attributes" | "resource">
>;

export type AuditHttpContextProvider =
  | AuditHttpContext
  | ((req: SecurityHttpRequest) => AuditHttpContext | Promise<AuditHttpContext>);

export interface AuthenticateOptions {
  readonly verifier: TokenVerifier;
  readonly principalKey?: PropertyKey;
  readonly audit?: AuditRecorder;
  readonly auditContext?: AuditHttpContextProvider;
}

export interface AuthorizeRouteOptions<R = unknown> {
  readonly action?: string;
  readonly resource?: R | ((req: SecurityHttpRequest) => R | Promise<R>);
  readonly principalKey?: PropertyKey;
  readonly audit?: AuditRecorder;
  readonly auditContext?: AuditHttpContextProvider;
}

export function authenticate(options: AuthenticateOptions) {
  const principalKey = options.principalKey ?? "principal";
  return async (req: SecurityHttpRequest, next: NextFunction) => {
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
      await recordAudit(req, options.audit, options.auditContext, {
        type: "authorization/deny",
        outcome: "deny",
        ...(options.action === undefined ? {} : { action: options.action }),
        reason: "principal_required",
      });
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
      await recordAudit(req, options.audit, options.auditContext, {
        type: "authorization/deny",
        outcome: "deny",
        principal: auditPrincipal(principal),
        ...(options.action === undefined ? {} : { action: options.action }),
        ...auditResource(resource),
        reason: decision.reason ?? "denied",
      });
      throw new AuthorizationError(decision.reason ?? "Access denied");
    }
    await recordAudit(req, options.audit, options.auditContext, {
      type: "authorization/allow",
      outcome: "allow",
      principal: auditPrincipal(principal),
      ...(options.action === undefined ? {} : { action: options.action }),
      ...auditResource(resource),
    });
    return next();
  };
}

async function recordAudit(
  req: SecurityHttpRequest,
  audit: AuditRecorder | undefined,
  provider: AuditHttpContextProvider | undefined,
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
  provider: AuditHttpContextProvider | undefined,
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

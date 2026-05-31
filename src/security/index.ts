export type {
  Clock,
  CounterLike,
  HistogramLike,
  LoggerLike,
  MeterLike,
  Principal,
  SecurityObservation,
  SecurityTelemetry,
  TokenVerifier,
  VerifyOptions,
} from "./types";

export {
  AlgorithmNotAllowedError,
  AuthenticationError,
  AuthorizationError,
  KeyResolutionError,
  SecurityError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
} from "./errors";

export {
  apiKeyFingerprint,
  createApiKeyVerifier,
  createJwtVerifier,
} from "./jwt";
export type {
  ApiKeyLookupResult,
  ApiKeyVerifierOptions,
  ClaimMapping,
  JwtHeader,
  JwtVerifierOptions,
  JwsAlgorithm,
} from "./jwt";

export {
  allow,
  allOf,
  anyOf,
  authorize,
  deny,
  not,
  requireRole,
  requireScope,
  requireTenant,
} from "./authz";
export type {
  AuthzContext,
  Decision,
  Policy,
} from "./authz";

export {
  auditPrincipal,
  createAuditRecorder,
  memoryAuditSink,
} from "./audit";
export type {
  AuditAttributes,
  AuditEvent,
  AuditEventInput,
  AuditEventType,
  AuditOutcome,
  AuditPrincipal,
  AuditRecorder,
  AuditRecorderOptions,
  AuditRequestContext,
  AuditResource,
  AuditSink,
  MemoryAuditSink,
} from "./audit";

export {
  authenticate,
  authorizeRoute,
} from "./http";
export type {
  AuditHttpContext,
  AuditHttpContextProvider,
  AuthenticateOptions,
  AuthorizeRouteOptions,
  HeadersLike,
  SecurityHandler,
  SecurityHttpRequest,
  SecurityMiddleware,
} from "./http";

export {
  createJwksKeyStore,
  hmacKeyStore,
  staticKeyStore,
} from "./jwks";
export type {
  FetchLike,
  HealthResult,
  JsonWebKeySet,
  JwksCacheOptions,
  KeySource,
  KeyStore,
  PipelineLike,
} from "./jwks";

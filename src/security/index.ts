export type {
  Clock,
  CounterLike,
  HistogramLike,
  LoggerLike,
  MeterLike,
  Principal,
  SecurityObservation,
  SecuritySpan,
  SecurityTelemetry,
  TokenVerifier,
  TracerLike,
  UpDownCounterLike,
  VerifyOptions,
} from "./types";

export {
  AlgorithmNotAllowedError,
  AuditError,
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
  createAuditLogger,
  hashAuditEvent,
  logSink,
  memoryAuditSink,
  memorySink,
  verifyAuditChain,
} from "./audit";
export type {
  AuditEvent,
  AuditEventInput,
  AuditLogger,
  AuditOptions,
  AuditOutcome,
  AuditPrincipal,
  AuditResource,
  AuditSink,
  LogSinkOptions,
  MemoryAuditSink,
} from "./audit";

export {
  securityHealthComponent,
} from "./lifecycle";
export type {
  LifecycleComponent,
  LifecycleHealthResult,
  LifecycleHealthStatus,
  SecurityHealthComponentOptions,
} from "./lifecycle";

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

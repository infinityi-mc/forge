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
  authenticate,
  authorizeRoute,
} from "./http";
export type {
  AuthenticateOptions,
  AuthorizeRouteOptions,
  HeadersLike,
  NextFunction,
  SecurityHttpRequest,
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

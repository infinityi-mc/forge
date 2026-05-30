import {
  AlgorithmNotAllowedError,
  AuthenticationError,
  KeyResolutionError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
} from "../errors";
import type { KeyStore } from "../jwks/types";
import { createJwksKeyStore, hmacKeyStore, staticKeyStore } from "../jwks/store";
import type { Principal, TokenVerifier, VerifyOptions } from "../types";
import {
  base64UrlDecode,
  decodeUtf8,
  encodeUtf8,
} from "./base64url";
import {
  isAsymmetricAlgorithm,
  isHmacAlgorithm,
  isJwsAlgorithm,
  verifyJwsSignature,
} from "./algorithms";
import type {
  ClaimMapping,
  JwtHeader,
  JwtVerifierOptions,
  JwsAlgorithm,
} from "./types";

const DEFAULT_CLOCK_TOLERANCE_MS = 60_000;

export function createJwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  validateOptions(options);
  const algorithms = new Set(options.algorithms);
  const issuers = toStringSet(options.issuer, "issuer");
  const audiences = toStringSet(options.audience, "audience");
  const keyStore = keyStoreFromSource(options.keys);
  const clock = options.clock ?? { now: () => Date.now() };
  const failureCounter = options.telemetry?.meter?.createCounter?.(
    "security.token.verify.failures",
    { description: "JWT verification failures" },
  );
  const durationHistogram = options.telemetry?.meter?.createHistogram?.(
    "security.token.verify.duration",
    { description: "JWT verification duration", unit: "ms" },
  );

  return {
    async verify(token: string, opts?: VerifyOptions): Promise<Principal> {
      const startedAt = clock.now();
      let alg: JwsAlgorithm | undefined;
      let issuer: string | undefined;
      try {
        const parsed = parseCompactJws(token);
        alg = validateAlgorithm(parsed.header, algorithms);
        const key = await keyStore.resolve(parsed.header.kid, alg);
        const valid = await verifyJwsSignature(
          alg,
          key,
          encodeUtf8(parsed.signingInput),
          parsed.signature,
        );
        if (!valid) throw new TokenInvalidError("JWT signature is invalid");
        issuer = stringClaim(parsed.claims, "iss");
        const principal = claimsToPrincipal(
          parsed.claims,
          {
            audiences,
            issuers,
            claimMap: options.claimMap,
            clockToleranceMs:
              opts?.clockToleranceMs ??
              options.clockToleranceMs ??
              DEFAULT_CLOCK_TOLERANCE_MS,
            now: clock.now(),
          },
        );
        durationHistogram?.record(clock.now() - startedAt, {
          alg,
          issuer: principal.issuer,
          outcome: "success",
        });
        return principal;
      } catch (error) {
        const reason = reasonForError(error);
        failureCounter?.add(1, { reason });
        durationHistogram?.record(clock.now() - startedAt, {
          alg: alg ?? "unknown",
          issuer: issuer ?? "unknown",
          outcome: "failure",
        });
        options.logger?.warn?.("JWT verification failed", { reason });
        throw normalizeAuthError(error);
      }
    },
  };
}

interface ParsedJws {
  readonly header: JwtHeader;
  readonly claims: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function parseCompactJws(token: string): ParsedJws {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new TokenInvalidError("JWT must be a compact JWS");
  }
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = JSON.parse(decodeUtf8(base64UrlDecode(encodedHeader)));
    const claims = JSON.parse(decodeUtf8(base64UrlDecode(encodedPayload)));
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      throw new TokenInvalidError("JWT header must be an object");
    }
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      throw new TokenInvalidError("JWT payload must be an object");
    }
    return {
      header: header as JwtHeader,
      claims: claims as Record<string, unknown>,
      signingInput: `${encodedHeader}.${encodedPayload}`,
      signature: base64UrlDecode(encodedSignature),
    };
  } catch (error) {
    if (error instanceof TokenInvalidError) throw error;
    throw new TokenInvalidError("JWT could not be decoded", { cause: error });
  }
}

function validateAlgorithm(
  header: JwtHeader,
  algorithms: ReadonlySet<JwsAlgorithm>,
): JwsAlgorithm {
  if (header.alg === "none") {
    throw new AlgorithmNotAllowedError("JWT alg none is not allowed");
  }
  if (typeof header.alg !== "string" || !isJwsAlgorithm(header.alg)) {
    throw new AlgorithmNotAllowedError("JWT alg is missing or unsupported");
  }
  if (!algorithms.has(header.alg)) {
    throw new AlgorithmNotAllowedError(`JWT alg ${header.alg} is not allowed`);
  }
  return header.alg;
}

interface ClaimValidationOptions {
  readonly audiences: ReadonlySet<string>;
  readonly issuers: ReadonlySet<string>;
  readonly claimMap?: ClaimMapping;
  readonly clockToleranceMs: number;
  readonly now: number;
}

function claimsToPrincipal(
  claims: Record<string, unknown>,
  options: ClaimValidationOptions,
): Principal {
  const issuer = stringClaim(claims, "iss");
  if (!options.issuers.has(issuer)) {
    throw new TokenClaimError("JWT issuer is not allowed");
  }
  const subject = stringClaim(claims, "sub");
  const audience = audienceClaim(claims.aud);
  if (!audience.some((value) => options.audiences.has(value))) {
    throw new TokenClaimError("JWT audience is not allowed");
  }

  const expSeconds = numericClaim(claims, "exp");
  const expMs = expSeconds * 1000;
  if (expMs + options.clockToleranceMs < options.now) {
    throw new TokenExpiredError("JWT is expired");
  }

  const nbf = optionalNumericClaim(claims, "nbf");
  if (nbf !== undefined && nbf * 1000 - options.clockToleranceMs > options.now) {
    throw new TokenClaimError("JWT is not yet valid");
  }

  const iat = optionalNumericClaim(claims, "iat");
  if (iat !== undefined && iat * 1000 - options.clockToleranceMs > options.now) {
    throw new TokenClaimError("JWT was issued in the future");
  }

  const rolesClaim = options.claimMap?.roles ?? "roles";
  const scopesClaim = options.claimMap?.scopes ?? "scope";
  const scopesValue = options.claimMap?.scopes === undefined
    ? claims[scopesClaim] ?? claims.scp
    : claims[scopesClaim];
  const tenantClaim = options.claimMap?.tenant;
  const tenant = tenantClaim === undefined
    ? undefined
    : optionalString(claims[tenantClaim], tenantClaim);

  return Object.freeze({
    subject,
    issuer,
    audience,
    roles: stringArrayClaim(claims[rolesClaim]),
    scopes: scopeClaim(scopesValue),
    ...(tenant === undefined ? {} : { tenant }),
    claims: Object.freeze({ ...claims }),
    issuedAt: new Date((iat ?? 0) * 1000),
    expiresAt: new Date(expMs),
  });
}

function validateOptions(options: JwtVerifierOptions): void {
  if (options.algorithms.length === 0) {
    throw new AlgorithmNotAllowedError("algorithms must be non-empty");
  }
  for (const algorithm of options.algorithms) {
    const value = algorithm as string;
    if (value === "none" || !isJwsAlgorithm(value)) {
      throw new AlgorithmNotAllowedError(`unsupported algorithm ${value}`);
    }
  }
  toStringSet(options.issuer, "issuer");
  toStringSet(options.audience, "audience");

  const hasHmac = options.algorithms.some(isHmacAlgorithm);
  const hasAsymmetric = options.algorithms.some(isAsymmetricAlgorithm);
  if (hasHmac && hasAsymmetric) {
    throw new AlgorithmNotAllowedError(
      "do not mix HMAC and asymmetric algorithms in one verifier",
    );
  }
  if (hasHmac && !("hmacSecret" in options.keys)) {
    throw new AlgorithmNotAllowedError(
      "HS algorithms require an hmacSecret key source",
    );
  }
  if (hasAsymmetric && "hmacSecret" in options.keys) {
    throw new AlgorithmNotAllowedError(
      "asymmetric algorithms require a JWKS key source",
    );
  }
  if (
    "hmacSecret" in options.keys &&
    typeof options.keys.hmacSecret === "string"
  ) {
    throw new KeyResolutionError("hmacSecret must be a Secret<string>");
  }
}

function keyStoreFromSource(source: JwtVerifierOptions["keys"]): KeyStore {
  if ("jwksUri" in source) return createJwksKeyStore(source);
  if ("jwks" in source) return staticKeyStore(source.jwks);
  return hmacKeyStore(source.hmacSecret);
}

function toStringSet(
  value: string | readonly string[],
  name: string,
): ReadonlySet<string> {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) => item.trim() === "")) {
    throw new TokenClaimError(`${name} must be non-empty`);
  }
  return new Set(values);
}

function stringClaim(claims: Record<string, unknown>, key: string): string {
  return optionalString(claims[key], key) ?? missingClaim(key);
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new TokenClaimError(`JWT ${key} claim must be a non-empty string`);
  }
  return value;
}

function numericClaim(claims: Record<string, unknown>, key: string): number {
  return optionalNumericClaim(claims, key) ?? missingClaim(key);
}

function optionalNumericClaim(
  claims: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = claims[key];
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || typeof value !== "number") {
    throw new TokenClaimError(`JWT ${key} claim must be a number`);
  }
  return value;
}

function audienceClaim(value: unknown): readonly string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item !== "")
  ) {
    return value;
  }
  throw new TokenClaimError("JWT aud claim must be a string or string array");
}

function stringArrayClaim(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item !== "");
  }
  return [];
}

function scopeClaim(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    return value.split(/\s+/).filter((part) => part.length > 0);
  }
  return stringArrayClaim(value);
}

function missingClaim(key: string): never {
  throw new TokenClaimError(`JWT ${key} claim is required`);
}

function normalizeAuthError(error: unknown): Error {
  if (
    error instanceof AuthenticationError ||
    error instanceof KeyResolutionError
  ) {
    return error;
  }
  return new TokenInvalidError("JWT verification failed", { cause: error });
}

function reasonForError(error: unknown): string {
  if (error instanceof TokenExpiredError) return "expired";
  if (error instanceof AlgorithmNotAllowedError) return "alg";
  if (error instanceof TokenClaimError) return "claim";
  if (error instanceof KeyResolutionError) return "key";
  if (error instanceof TokenInvalidError) return "invalid";
  return "unknown";
}

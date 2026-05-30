import { Secret } from "../../config/secret";
import {
  AuthenticationError,
  TokenInvalidError,
} from "../errors";
import {
  generateKeyPairForTest,
  importHmacSecret,
  isHmacAlgorithm,
  signForTest,
} from "../jwt/algorithms";
import {
  base64UrlEncodeBytes,
  base64UrlEncodeJson,
} from "../jwt/base64url";
import { encodeUtf8 } from "../jwt/base64url";
import type { JwsAlgorithm } from "../jwt/types";
import { staticKeyStore } from "../jwks";
import type { JsonWebKeySet, KeyStore } from "../jwks";
import type { Principal, TokenVerifier } from "../types";
import { memoryAuditSink } from "../audit";
export {
  memoryAuditSink,
  type MemoryAuditSink,
} from "../audit";

export interface FakePrincipalOptions {
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: readonly string[];
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly tenant?: string;
  readonly claims?: Record<string, unknown>;
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
}

export function fakePrincipal(options: FakePrincipalOptions = {}): Principal {
  const issuedAt = options.issuedAt ?? new Date(1_700_000_000_000);
  const expiresAt = options.expiresAt ?? new Date(1_700_003_600_000);
  const subject = options.subject ?? "user_1";
  const issuer = options.issuer ?? "https://issuer.test";
  const audience = options.audience ?? ["api"];
  const roles = options.roles ?? [];
  const scopes = options.scopes ?? [];
  const claims = {
    iss: issuer,
    sub: subject,
    aud: audience,
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    ...(options.claims ?? {}),
  };
  return Object.freeze({
    subject,
    issuer,
    audience,
    roles,
    scopes,
    ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    claims: Object.freeze(claims),
    issuedAt,
    expiresAt,
  });
}

export interface TestVerifierOptions {
  readonly principalFor?:
    | Principal
    | ((token: string) => Principal | AuthenticationError | Promise<Principal | AuthenticationError>);
}

export function testVerifier(options: TestVerifierOptions = {}): TokenVerifier {
  return {
    async verify(token) {
      const resolver = options.principalFor ?? fakePrincipal();
      const result = typeof resolver === "function" ? await resolver(token) : resolver;
      if (result instanceof AuthenticationError) throw result;
      return result;
    },
  };
}

export interface SignTestJwtOptions {
  readonly algorithm?: JwsAlgorithm;
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  readonly subject?: string;
  readonly kid?: string;
  readonly now?: Date;
  readonly expiresInMs?: number;
  readonly notBefore?: Date;
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  readonly secret?: Secret<string>;
  readonly keyPair?: CryptoKeyPair;
}

export interface SignedTestJwt {
  readonly token: string;
  readonly algorithm: JwsAlgorithm;
  readonly kid: string;
  readonly claims: Record<string, unknown>;
  readonly jwks?: JsonWebKeySet;
  readonly keyStore?: KeyStore;
  readonly secret?: Secret<string>;
  readonly keyPair?: CryptoKeyPair;
}

export async function signTestJwt(
  options: SignTestJwtOptions = {},
): Promise<SignedTestJwt> {
  const algorithm = options.algorithm ?? "RS256";
  const kid = options.kid ?? "test-key";
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = Math.floor(
    (now.getTime() + (options.expiresInMs ?? 60 * 60 * 1000)) / 1000,
  );
  const claims: Record<string, unknown> = {
    iss: options.issuer ?? "https://issuer.test",
    aud: options.audience ?? "api",
    sub: options.subject ?? "user_1",
    iat: issuedAt,
    exp: expiresAt,
    ...(options.notBefore === undefined
      ? {}
      : { nbf: Math.floor(options.notBefore.getTime() / 1000) }),
    ...(options.claims ?? {}),
  };
  const header = {
    typ: "JWT",
    alg: algorithm,
    kid,
    ...(options.header ?? {}),
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const signingBytes = encodeUtf8(signingInput);

  if (isHmacAlgorithm(algorithm)) {
    const secret = options.secret ?? new Secret("test-secret");
    const key = await importHmacSecret(secret, algorithm, "sign");
    const signature = await signForTest(algorithm, key, signingBytes);
    return {
      token: `${signingInput}.${base64UrlEncodeBytes(signature)}`,
      algorithm,
      kid,
      claims,
      secret,
    };
  }

  const keyPair = options.keyPair ?? await generateKeyPairForTest(algorithm);
  const signature = await signForTest(algorithm, keyPair.privateKey, signingBytes);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwk = { ...publicJwk, kid, alg: algorithm, use: "sig" };
  const jwks: JsonWebKeySet = { keys: [jwk] };
  return {
    token: `${signingInput}.${base64UrlEncodeBytes(signature)}`,
    algorithm,
    kid,
    claims,
    jwks,
    keyStore: staticKeyStore(jwks),
    keyPair,
  };
}

export interface TestSecurityHarness {
  readonly principal: Principal;
  readonly verifier: TokenVerifier;
  readonly audit: import("../audit").MemoryAuditSink;
}

export function createTestSecurity(
  principal: Principal = fakePrincipal(),
): TestSecurityHarness {
  return {
    principal,
    verifier: testVerifier({ principalFor: principal }),
    audit: memoryAuditSink(),
  };
}

export async function tamperJwtPayload(token: string): Promise<string> {
  const [header, _payload, signature] = token.split(".");
  if (header === undefined || signature === undefined) {
    throw new TokenInvalidError("JWT must be a compact JWS");
  }
  const alteredPayload = base64UrlEncodeJson({ sub: "tampered" });
  return `${header}.${alteredPayload}.${signature}`;
}

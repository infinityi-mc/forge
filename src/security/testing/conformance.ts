import {
  AlgorithmNotAllowedError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
} from "../errors";
import { createJwtVerifier } from "../jwt";
import type { JwtVerifierOptions } from "../jwt";
import type { TokenVerifier } from "../types";
import { signTestJwt } from "./helpers";

export interface VerifierHarness {
  readonly verifier: TokenVerifier;
  readonly token: string;
}

export type VerifierFactory = () =>
  | Promise<VerifierHarness>
  | VerifierHarness;

export interface SecurityConformanceScenario {
  readonly name: string;
  run(factory: VerifierFactory): Promise<void>;
}

export const STANDARD_SECURITY_SCENARIOS: readonly SecurityConformanceScenario[] =
  [
    {
      name: "valid JWT verifies to a principal",
      async run(factory) {
        const { verifier, token } = await factory();
        const principal = await verifier.verify(token);
        if (principal.subject !== "user_1") {
          throw new Error(`expected subject user_1, got ${principal.subject}`);
        }
      },
    },
  ];

export const JWT_REGRESSION_SCENARIOS: readonly SecurityConformanceScenario[] =
  [
    {
      name: "alg none is rejected",
      async run() {
        const signed = await signTestJwt();
        const verifier = createJwtVerifier(defaultVerifierOptions(signed));
        const token = unsignedToken({ alg: "none" }, {
          iss: "https://issuer.test",
          aud: "api",
          sub: "user_1",
          iat: seconds(Date.now()),
          exp: seconds(Date.now() + 60_000),
        });
        const error = await verifier.verify(token).catch((e) => e);
        if (!(error instanceof AlgorithmNotAllowedError)) {
          throw new Error(`expected AlgorithmNotAllowedError, got ${nameOf(error)}`);
        }
      },
    },
    {
      name: "expired token is rejected",
      async run() {
        const signed = await signTestJwt({ expiresInMs: -120_000 });
        const verifier = createJwtVerifier({
          ...defaultVerifierOptions(signed),
          clockToleranceMs: 0,
        });
        const error = await verifier.verify(signed.token).catch((e) => e);
        if (!(error instanceof TokenExpiredError)) {
          throw new Error(`expected TokenExpiredError, got ${nameOf(error)}`);
        }
      },
    },
    {
      name: "wrong issuer is rejected",
      async run() {
        const signed = await signTestJwt({ issuer: "https://issuer.test" });
        const verifier = createJwtVerifier({
          ...defaultVerifierOptions(signed),
          issuer: "https://other-issuer.test",
        });
        const error = await verifier.verify(signed.token).catch((e) => e);
        if (!(error instanceof TokenClaimError)) {
          throw new Error(`expected TokenClaimError, got ${nameOf(error)}`);
        }
      },
    },
    {
      name: "wrong audience is rejected",
      async run() {
        const signed = await signTestJwt({ audience: "api" });
        const verifier = createJwtVerifier({
          ...defaultVerifierOptions(signed),
          audience: "other-api",
        });
        const error = await verifier.verify(signed.token).catch((e) => e);
        if (!(error instanceof TokenClaimError)) {
          throw new Error(`expected TokenClaimError, got ${nameOf(error)}`);
        }
      },
    },
    {
      name: "malformed token is rejected",
      async run() {
        const signed = await signTestJwt();
        const verifier = createJwtVerifier(defaultVerifierOptions(signed));
        const error = await verifier.verify("not-a-jwt").catch((e) => e);
        if (!(error instanceof TokenInvalidError)) {
          throw new Error(`expected TokenInvalidError, got ${nameOf(error)}`);
        }
      },
    },
  ];

export async function assertConformance(
  factory: VerifierFactory,
  scenarios: readonly SecurityConformanceScenario[] = STANDARD_SECURITY_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `security conformance: "${scenario.name}" failed - ${message}`,
        { cause: error },
      );
    }
  }
}

function defaultVerifierOptions(
  signed: Awaited<ReturnType<typeof signTestJwt>>,
): JwtVerifierOptions {
  if (signed.jwks === undefined) {
    throw new Error("expected signed test JWT to include a JWKS");
  }
  return {
    keys: { jwks: signed.jwks },
    algorithms: [signed.algorithm],
    issuer: "https://issuer.test",
    audience: "api",
  };
}

function unsignedToken(header: object, payload: object): string {
  return `${encodeJson(header)}.${encodeJson(payload)}.unsigned`;
}

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function nameOf(value: unknown): string {
  return (value as { constructor?: { name?: string } } | undefined)?.constructor
    ?.name ?? typeof value;
}

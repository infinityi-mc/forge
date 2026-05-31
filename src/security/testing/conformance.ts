import { allOf, anyOf, authorize, deny } from "../authz";
import type { AuthzContext, Policy } from "../authz";
import { createAuditLogger, memorySink } from "../audit";
import {
  AlgorithmNotAllowedError,
  KeyResolutionError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
} from "../errors";
import { createJwtVerifier } from "../jwt";
import type { JwtVerifierOptions } from "../jwt";
import { createJwksKeyStore } from "../jwks";
import type { TokenVerifier } from "../types";
import { fakePrincipal, signTestJwt } from "./helpers";

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
    {
      name: "HS256 token is rejected by an RS256/JWKS verifier (algorithm confusion)",
      async run() {
        const signed = await signTestJwt({ algorithm: "RS256" });
        // Attacker forges an HS256 token; the verifier only allows RS256, so
        // the alg allow-list rejects it before any key confusion is possible.
        const forged = await signTestJwt({ algorithm: "HS256" });
        const verifier = createJwtVerifier(defaultVerifierOptions(signed));
        const error = await verifier.verify(forged.token).catch((e) => e);
        if (!(error instanceof AlgorithmNotAllowedError)) {
          throw new Error(
            `expected AlgorithmNotAllowedError, got ${nameOf(error)}`,
          );
        }
      },
    },
    {
      name: "unknown kid triggers exactly one JWKS refetch (no stampede)",
      async run() {
        const signed = await signTestJwt({ kid: "k1" });
        if (signed.jwks === undefined) {
          throw new Error("expected signed test JWT to include a JWKS");
        }
        const jwks = signed.jwks;
        let fetches = 0;
        const fetchLike = async (): Promise<Response> => {
          fetches++;
          await Promise.resolve();
          return new Response(JSON.stringify(jwks), {
            headers: { "content-type": "application/json" },
          });
        };
        const store = createJwksKeyStore({
          jwksUri: "https://issuer.test/jwks",
          fetch: fetchLike,
          cache: { minRefetchIntervalMs: 60_000 },
        });
        // Prime the cache so the forced refetch is the only network call.
        await store.resolve("k1", "RS256");
        fetches = 0;

        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            store.resolve("unknown", "RS256").catch((e) => e),
          ),
        );
        for (const result of results) {
          if (!(result instanceof KeyResolutionError)) {
            throw new Error(`expected KeyResolutionError, got ${nameOf(result)}`);
          }
        }
        if (fetches !== 1) {
          throw new Error(`expected exactly one refetch, got ${fetches}`);
        }
      },
    },
  ];

/** Authorization decision conformance (fail-closed + short-circuit). */
export const AUTHZ_CONFORMANCE_SCENARIOS: readonly SecurityConformanceScenario[] =
  [
    {
      name: "a policy that throws results in deny (fail-closed)",
      async run() {
        const policy: Policy = () => {
          throw new Error("policy boom");
        };
        const decision = await authorize(policy, baseContext());
        if (decision.effect !== "deny") {
          throw new Error(`expected deny, got ${decision.effect}`);
        }
      },
    },
    {
      name: "allOf short-circuits on the first deny",
      async run() {
        let evaluatedAfterDeny = false;
        const decision = await authorize(
          allOf(deny("blocked"), () => {
            evaluatedAfterDeny = true;
            return { effect: "allow" };
          }),
          baseContext(),
        );
        if (decision.effect !== "deny") {
          throw new Error(`expected deny, got ${decision.effect}`);
        }
        if (evaluatedAfterDeny) {
          throw new Error("allOf did not short-circuit on the first deny");
        }
      },
    },
    {
      name: "anyOf short-circuits on the first allow",
      async run() {
        let evaluatedAfterAllow = false;
        const decision = await authorize(
          anyOf(
            () => ({ effect: "allow" }),
            () => {
              evaluatedAfterAllow = true;
              return { effect: "deny", reason: "blocked" };
            },
          ),
          baseContext(),
        );
        if (decision.effect !== "allow") {
          throw new Error(`expected allow, got ${decision.effect}`);
        }
        if (evaluatedAfterAllow) {
          throw new Error("anyOf did not short-circuit on the first allow");
        }
      },
    },
  ];

/** Audit conformance: one safe event per decision, redaction applied. */
export const AUDIT_CONFORMANCE_SCENARIOS: readonly SecurityConformanceScenario[] =
  [
    {
      name: "verification emits exactly one audit event with no token/secret material",
      async run() {
        const signed = await signTestJwt();
        const sink = memorySink();
        const verifier = createJwtVerifier({
          ...defaultVerifierOptions(signed),
          audit: createAuditLogger({ sink }),
        });
        await verifier.verify(signed.token);

        if (sink.events.length !== 1) {
          throw new Error(`expected one audit event, got ${sink.events.length}`);
        }
        if (sink.events[0]?.action !== "auth.token.verified") {
          throw new Error(`unexpected action ${sink.events[0]?.action}`);
        }
        const serialized = JSON.stringify(sink.events[0]);
        if (serialized.includes(signed.token)) {
          throw new Error("audit event leaked the raw token");
        }
      },
    },
    {
      name: "redaction is applied before the sink receives the event",
      async run() {
        const sink = memorySink();
        const logger = createAuditLogger({ sink, redact: ["token"] });
        await logger.record({
          action: "auth.token.verified",
          outcome: "success",
          metadata: { token: "raw-secret-token" },
        });
        const metadata = sink.events[0]?.metadata;
        if (metadata?.token !== "[REDACTED]") {
          throw new Error("redaction was not applied before the sink");
        }
        if (JSON.stringify(sink.events[0]).includes("raw-secret-token")) {
          throw new Error("sink received unredacted material");
        }
      },
    },
  ];

/**
 * The full regression battery: JWT verification, authorization, and audit
 * conformance. Each scenario builds its own fixtures and ignores the factory.
 */
export const SECURITY_REGRESSION_SCENARIOS: readonly SecurityConformanceScenario[] =
  [
    ...JWT_REGRESSION_SCENARIOS,
    ...AUTHZ_CONFORMANCE_SCENARIOS,
    ...AUDIT_CONFORMANCE_SCENARIOS,
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

function baseContext(): AuthzContext {
  return { principal: fakePrincipal(), action: "conformance:check" };
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function nameOf(value: unknown): string {
  return (value as { constructor?: { name?: string } } | undefined)?.constructor
    ?.name ?? typeof value;
}

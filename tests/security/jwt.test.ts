import { describe, expect, test } from "bun:test";
import { Secret } from "../../src/config";
import {
  AlgorithmNotAllowedError,
  KeyResolutionError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
  createJwtVerifier,
} from "../../src/security";
import {
  SECURITY_REGRESSION_SCENARIOS,
  STANDARD_SECURITY_SCENARIOS,
  assertConformance,
  fakePrincipal,
  signTestJwt,
  tamperJwtPayload,
  testVerifier,
} from "../../src/security/testing";

describe("createJwtVerifier", () => {
  test("verifies an RS256 compact JWT into a Principal", async () => {
    const signed = await signTestJwt({
      claims: {
        roles: ["admin", "operator"],
        scope: "reports:read reports:write",
        tenant_id: "tenant_1",
      },
    });

    const verifier = createJwtVerifier({
      keys: { jwks: signed.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      claimMap: { tenant: "tenant_id" },
    });

    const principal = await verifier.verify(signed.token);
    expect(principal.subject).toBe("user_1");
    expect(principal.issuer).toBe("https://issuer.test");
    expect(principal.audience).toEqual(["api"]);
    expect(principal.roles).toEqual(["admin", "operator"]);
    expect(principal.scopes).toEqual(["reports:read", "reports:write"]);
    expect(principal.tenant).toBe("tenant_1");
    expect(principal.expiresAt).toBeInstanceOf(Date);
  });

  test("verifies an HS256 compact JWT with a Secret<string>", async () => {
    const secret = new Secret("shared-secret");
    const signed = await signTestJwt({ algorithm: "HS256", secret });
    const verifier = createJwtVerifier({
      keys: { hmacSecret: secret },
      algorithms: ["HS256"],
      issuer: "https://issuer.test",
      audience: "api",
    });

    await expect(verifier.verify(signed.token)).resolves.toMatchObject({
      subject: "user_1",
    });
  });

  test("custom scopes claim mapping does not fall back to scp", async () => {
    const signed = await signTestJwt({
      claims: {
        scp: "reports:admin",
      },
    });
    const verifier = createJwtVerifier({
      keys: { jwks: signed.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      claimMap: { scopes: "permissions" },
    });

    await expect(verifier.verify(signed.token)).resolves.toMatchObject({
      scopes: [],
    });
  });

  test("fails fast on unsafe or incomplete verifier configuration", async () => {
    const signed = await signTestJwt();

    expect(() =>
      createJwtVerifier({
        keys: { jwks: signed.jwks! },
        algorithms: [],
        issuer: "https://issuer.test",
        audience: "api",
      }),
    ).toThrow(AlgorithmNotAllowedError);

    expect(() =>
      createJwtVerifier({
        keys: { jwks: signed.jwks! },
        algorithms: ["HS256"],
        issuer: "https://issuer.test",
        audience: "api",
      }),
    ).toThrow(AlgorithmNotAllowedError);

    expect(() =>
      createJwtVerifier({
        keys: { hmacSecret: "raw-secret" } as any,
        algorithms: ["HS256"],
        issuer: "https://issuer.test",
        audience: "api",
      }),
    ).toThrow(KeyResolutionError);

    expect(() =>
      createJwtVerifier({
        keys: { jwks: signed.jwks! },
        algorithms: ["none" as any],
        issuer: "https://issuer.test",
        audience: "api",
      }),
    ).toThrow(AlgorithmNotAllowedError);
  });

  test("rejects malformed, unsigned, tampered, and claim-invalid tokens", async () => {
    const signed = await signTestJwt();
    const verifier = createJwtVerifier({
      keys: { jwks: signed.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      clockToleranceMs: 0,
    });

    await expect(verifier.verify("not-a-jwt")).rejects.toThrow(
      TokenInvalidError,
    );
    await expect(
      verifier.verify(await tamperJwtPayload(signed.token)),
    ).rejects.toThrow(TokenInvalidError);

    const noneToken = tokenWithHeader({ alg: "none" }, signed.claims);
    await expect(verifier.verify(noneToken)).rejects.toThrow(
      AlgorithmNotAllowedError,
    );

    const expired = await signTestJwt({ expiresInMs: -60_000 });
    const expiredVerifier = createJwtVerifier({
      keys: { jwks: expired.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      clockToleranceMs: 0,
    });
    await expect(expiredVerifier.verify(expired.token)).rejects.toThrow(
      TokenExpiredError,
    );

    const wrongClaims = await signTestJwt({ issuer: "https://issuer.test" });
    const wrongIssuerVerifier = createJwtVerifier({
      keys: { jwks: wrongClaims.jwks! },
      algorithms: ["RS256"],
      issuer: "https://other.test",
      audience: "api",
    });
    await expect(wrongIssuerVerifier.verify(wrongClaims.token)).rejects.toThrow(
      TokenClaimError,
    );
  });

  test("test verifier and conformance helper work with canned principals", async () => {
    const principal = fakePrincipal({ subject: "user_2" });
    const verifier = testVerifier({ principalFor: principal });
    await expect(verifier.verify("token")).resolves.toMatchObject({
      subject: "user_2",
    });

    const signed = await signTestJwt();
    const factory = () => ({
      token: signed.token,
      verifier: createJwtVerifier({
        keys: { jwks: signed.jwks! },
        algorithms: ["RS256"],
        issuer: "https://issuer.test",
        audience: "api",
      }),
    });
    await assertConformance(factory, STANDARD_SECURITY_SCENARIOS);
    await assertConformance(factory, SECURITY_REGRESSION_SCENARIOS);
  });

  test("rejects oversized tokens before key resolution or signature checks", async () => {
    const signed = await signTestJwt();
    let fetches = 0;
    const verifier = createJwtVerifier({
      keys: {
        jwksUri: "https://issuer.test/jwks",
        fetch: async () => {
          fetches++;
          return new Response(JSON.stringify(signed.jwks!));
        },
      },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      limits: { maxTokenBytes: 64 },
    });
    // A token longer than maxTokenBytes is rejected before JWKS fetch/signature work.
    const huge = `${"a".repeat(100)}.${"b".repeat(100)}.${"c".repeat(100)}`;
    const error = await verifier.verify(huge).catch((e) => e);
    expect(error).toBeInstanceOf(TokenInvalidError);
    expect((error as Error).message).toContain("maximum size");
    expect(fetches).toBe(0);
  });

  test("rejects an oversized header segment before JSON parse", async () => {
    const signed = await signTestJwt();
    const verifier = createJwtVerifier({
      keys: { jwks: signed.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
      limits: { maxHeaderBytes: 8 },
    });
    const token = tokenWithHeader(
      { alg: "RS256", kid: "a-very-long-key-id-that-exceeds-the-header-limit" },
      { sub: "user_1" },
    );
    await expect(verifier.verify(token)).rejects.toThrow(TokenInvalidError);
  });

  test("default limits still admit a normal-sized token", async () => {
    const signed = await signTestJwt();
    const verifier = createJwtVerifier({
      keys: { jwks: signed.jwks! },
      algorithms: ["RS256"],
      issuer: "https://issuer.test",
      audience: "api",
    });
    await expect(verifier.verify(signed.token)).resolves.toMatchObject({
      subject: "user_1",
    });
  });
});

function tokenWithHeader(header: object, payload: object): string {
  return `${encodeJson(header)}.${encodeJson(payload)}.${encodeJson("signature")}`;
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

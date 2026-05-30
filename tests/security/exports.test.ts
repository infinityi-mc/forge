import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as security from "../../src/security";
import * as errors from "../../src/security/errors";
import * as jwks from "../../src/security/jwks";
import * as jwt from "../../src/security/jwt";
import * as testing from "../../src/security/testing";

describe("security exports", () => {
  test("security symbols stay scoped to forge/security", () => {
    expect(security.createJwtVerifier).toBeFunction();
    expect(security.staticKeyStore).toBeFunction();
    expect("createJwtVerifier" in root).toBe(false);
  });

  test("submodule entrypoints expose their PR A surfaces", () => {
    expect(jwt.createJwtVerifier).toBeFunction();
    expect(jwks.createJwksKeyStore).toBeFunction();
    expect(jwks.staticKeyStore).toBeFunction();
    expect(jwks.hmacKeyStore).toBeFunction();
    expect(testing.fakePrincipal).toBeFunction();
    expect(testing.signTestJwt).toBeFunction();
  });

  test("error taxonomy is exported", () => {
    expect(new security.TokenInvalidError("x")).toBeInstanceOf(
      security.AuthenticationError,
    );
    expect(new security.TokenExpiredError("x")).toBeInstanceOf(
      security.AuthenticationError,
    );
    expect(new security.TokenClaimError("x")).toBeInstanceOf(
      security.AuthenticationError,
    );
    expect(new security.AlgorithmNotAllowedError("x")).toBeInstanceOf(
      security.AuthenticationError,
    );
    expect(new errors.KeyResolutionError("x")).toBeInstanceOf(
      errors.SecurityError,
    );
  });
});


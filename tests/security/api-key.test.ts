import { describe, expect, test } from "bun:test";
import {
  TokenInvalidError,
  apiKeyFingerprint,
  createApiKeyVerifier,
} from "../../src/security";
import { fakePrincipal } from "../../src/security/testing";

describe("createApiKeyVerifier", () => {
  test("verifies a valid API key to the looked-up principal", async () => {
    const rawKey = "forge_test_key_123";
    const fingerprint = await apiKeyFingerprint(rawKey);
    const principal = fakePrincipal({ subject: "api_user" });
    let lookupFingerprint: string | undefined;

    const verifier = createApiKeyVerifier({
      lookup(value) {
        lookupFingerprint = value;
        return { fingerprint, principal };
      },
    });

    await expect(verifier.verify(rawKey)).resolves.toBe(principal);
    expect(lookupFingerprint).toBe(fingerprint);
  });

  test("unknown and malformed keys reject with TokenInvalidError", async () => {
    const verifier = createApiKeyVerifier({
      lookup: () => undefined,
    });

    await expect(verifier.verify("missing")).rejects.toThrow(TokenInvalidError);
    await expect(verifier.verify("")).rejects.toThrow(TokenInvalidError);
    await expect(verifier.verify("   ")).rejects.toThrow(TokenInvalidError);
  });

  test("returned fingerprint mismatch rejects", async () => {
    const rawKey = "forge_test_key_456";
    const principal = fakePrincipal();
    const verifier = createApiKeyVerifier({
      lookup: () => ({ fingerprint: "different", principal }),
    });

    await expect(verifier.verify(rawKey)).rejects.toThrow(TokenInvalidError);
  });

  test("fingerprint helper is deterministic and does not expose the raw key", async () => {
    const rawKey = "forge_test_key_secret";
    const first = await apiKeyFingerprint(rawKey);
    const second = await apiKeyFingerprint(rawKey);

    expect(first).toBe(second);
    expect(first).not.toContain(rawKey);
    expect(first).not.toBe(rawKey);
  });
});

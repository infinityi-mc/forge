import { describe, expect, test } from "bun:test";
import {
  TokenInvalidError,
  apiKeyFingerprint,
  createApiKeyVerifier,
  generateApiKey,
} from "../../src/security";
import { Secret } from "../../src/config/secret";
import { fakePrincipal } from "../../src/security/testing";

describe("createApiKeyVerifier", () => {
  test("verifies a valid API key to the looked-up principal", async () => {
    const rawKey = "forge_test_key_1234567890_abcdefghij";
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
    const rawKey = "forge_test_key_4567890123_abcdefghij";
    const principal = fakePrincipal();
    const verifier = createApiKeyVerifier({
      lookup: () => ({ fingerprint: "different", principal }),
    });

    await expect(verifier.verify(rawKey)).rejects.toThrow(TokenInvalidError);
  });

  test("fingerprint helper is deterministic and does not expose the raw key", async () => {
    const rawKey = "forge_test_key_secret_0123456789_abcd";
    const first = await apiKeyFingerprint(rawKey);
    const second = await apiKeyFingerprint(rawKey);

    expect(first).toBe(second);
    expect(first).not.toContain(rawKey);
    expect(first).not.toBe(rawKey);
  });

  test("rejects keys shorter than the default minimum length", async () => {
    const verifier = createApiKeyVerifier({ lookup: () => undefined });
    // 18 chars < default minLength 32.
    await expect(verifier.verify("forge_test_key_123")).rejects.toThrow(
      TokenInvalidError,
    );
  });

  test("policy can relax minLength and enforce a prefix", async () => {
    const principal = fakePrincipal();
    const fingerprint = await apiKeyFingerprint("fk_short", {
      policy: { minLength: 1 },
    });
    const verifier = createApiKeyVerifier({
      policy: { minLength: 1, requirePrefix: "fk_" },
      lookup: () => ({ fingerprint, principal }),
    });

    await expect(verifier.verify("fk_short")).resolves.toBe(principal);
    // Wrong prefix is rejected by policy before lookup.
    await expect(verifier.verify("xx_short")).rejects.toThrow(TokenInvalidError);
  });

  test("generateApiKey produces high-entropy, prefixed, unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toStartWith("fk_");
    expect(a).not.toBe(b);
    // 32 random bytes → >40 base64url chars, plus prefix.
    expect(a.length).toBeGreaterThanOrEqual(32);

    const custom = generateApiKey({ prefix: "svc_", bytes: 16 });
    expect(custom).toStartWith("svc_");
  });

  test("generated keys always satisfy the default verifier policy", async () => {
    // Even a small requested byte count is floored so the key is accepted by
    // the default minLength (32) — generator and verifier never disagree.
    const principal = fakePrincipal();
    for (const bytes of [1, 8, 16, 32]) {
      const rawKey = generateApiKey({ bytes });
      const fingerprint = await apiKeyFingerprint(rawKey);
      const verifier = createApiKeyVerifier({
        lookup: () => ({ fingerprint, principal }),
      });
      await expect(verifier.verify(rawKey)).resolves.toBe(principal);
    }
  });

  test("pepper changes the fingerprint and is required to reproduce it", async () => {
    const rawKey = generateApiKey();
    const plain = await apiKeyFingerprint(rawKey);
    const peppered = await apiKeyFingerprint(rawKey, {
      pepper: new Secret("server-pepper"),
    });
    const peppered2 = await apiKeyFingerprint(rawKey, {
      pepper: new Secret("different-pepper"),
    });

    expect(peppered).not.toBe(plain);
    expect(peppered).not.toBe(peppered2);
  });
});

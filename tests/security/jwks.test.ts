import { describe, expect, test } from "bun:test";
import {
  KeyResolutionError,
  createJwksKeyStore,
  staticKeyStore,
} from "../../src/security";
import { signTestJwt } from "../../src/security/testing";

describe("security JWKS key stores", () => {
  test("staticKeyStore resolves by kid and algorithm", async () => {
    const signed = await signTestJwt();
    const store = staticKeyStore(signed.jwks!);
    await expect(store.resolve(signed.kid, "RS256")).resolves.toBeInstanceOf(
      CryptoKey,
    );
    await expect(store.resolve("missing", "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });

  test("createJwksKeyStore caches keys and coordinates unknown-kid refetch", async () => {
    const first = await signTestJwt({ kid: "kid-1" });
    const second = await signTestJwt({ kid: "kid-2" });
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      const jwks = fetches === 1 ? first.jwks! : second.jwks!;
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "cache-control": "max-age=60" },
      });
    };

    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/.well-known/jwks.json",
      fetch,
    });

    await store.resolve("kid-1", "RS256");
    await Promise.all([
      store.resolve("kid-2", "RS256"),
      store.resolve("kid-2", "RS256"),
      store.resolve("kid-2", "RS256"),
    ]);

    expect(fetches).toBe(2);
  });

  test("health reports unhealthy when JWKS fetch fails", async () => {
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/.well-known/jwks.json",
      fetch: async () => new Response("nope", { status: 503 }),
    });

    await expect(store.health()).resolves.toMatchObject({
      status: "unhealthy",
    });
  });
});


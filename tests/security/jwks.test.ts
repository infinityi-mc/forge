import { describe, expect, test } from "bun:test";
import {
  KeyResolutionError,
  createAuditLogger,
  createJwksKeyStore,
  memorySink,
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

  test("staticKeyStore ignores JWKs that are not allowed for signature verification", async () => {
    const signed = await signTestJwt();
    const [jwk] = signed.jwks!.keys;
    expect(jwk).toBeDefined();

    const encryptionUseStore = staticKeyStore({
      keys: [{ ...jwk!, use: "enc" }],
    });
    await expect(
      encryptionUseStore.resolve(signed.kid, "RS256"),
    ).rejects.toThrow(KeyResolutionError);

    const encryptionOpsStore = staticKeyStore({
      keys: [{ ...jwk!, key_ops: ["encrypt"] }],
    });
    await expect(
      encryptionOpsStore.resolve(signed.kid, "RS256"),
    ).rejects.toThrow(KeyResolutionError);

    const verifyOpsStore = staticKeyStore({
      keys: [{ ...jwk!, key_ops: ["verify"] }],
    });
    await expect(
      verifyOpsStore.resolve(signed.kid, "RS256"),
    ).resolves.toBeInstanceOf(CryptoKey);

    const mixedStore = staticKeyStore({
      keys: [{ ...jwk!, use: "enc" }, jwk!],
    });
    await expect(
      mixedStore.resolve(signed.kid, "RS256"),
    ).resolves.toBeInstanceOf(CryptoKey);
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

  test("emits refetch + cache-size metrics and audits key rotation", async () => {
    const first = await signTestJwt({ kid: "kid-1" });
    const second = await signTestJwt({ kid: "kid-2" });
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      if (fetches === 2) {
        return new Response("nope", { status: 503 });
      }
      const jwks = fetches === 1 ? first.jwks! : second.jwks!;
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "cache-control": "max-age=60" },
      });
    };

    const refetch: Array<Record<string, unknown>> = [];
    const cacheSize: number[] = [];
    const sink = memorySink();
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/.well-known/jwks.json",
      fetch,
      // This test exercises the failure→success refetch path back-to-back;
      // disable the unknown-kid throttle so the immediate retry is allowed.
      cache: { minRefetchIntervalMs: 0 },
      telemetry: {
        meter: {
          createCounter: (name: string) => ({
            add: (_value: number, attributes?: Record<string, unknown>) => {
              if (name === "security.jwks.refetch") {
                refetch.push(attributes ?? {});
              }
            },
          }),
          createUpDownCounter: (name: string) => ({
            add: (value: number) => {
              if (name === "security.jwks.cache.size") {
                cacheSize.push(value);
              }
            },
          }),
        },
      },
      audit: createAuditLogger({ sink }),
    });

    await store.resolve("kid-1", "RS256");
    // Unknown kid forces a refetch that fails (failure outcome), then a
    // successful refetch that rotates in kid-2.
    await store.resolve("kid-2", "RS256").catch(() => undefined);
    await store.resolve("kid-2", "RS256");
    // Rotation audit is fire-and-forget; let its microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(refetch).toContainEqual({ outcome: "success" });
    expect(refetch).toContainEqual({ outcome: "failure" });
    expect(cacheSize.length).toBeGreaterThan(0);

    const rotation = sink.events.find((e) => e.action === "auth.key.rotated");
    expect(rotation).toBeDefined();
    expect(rotation?.outcome).toBe("success");
    expect(JSON.stringify(rotation)).toContain("kid-2");
  });

  test("rejects non-HTTPS jwksUri by default and allows opt-out", async () => {
    expect(() =>
      createJwksKeyStore({ jwksUri: "http://issuer.test/jwks" }),
    ).toThrow(KeyResolutionError);
    // Opt-out restores http support.
    expect(() =>
      createJwksKeyStore({
        jwksUri: "http://issuer.test/jwks",
        cache: { allowInsecureHttp: true },
      }),
    ).not.toThrow();
  });

  test("rejects a jwksUri whose host is not in the allowlist", async () => {
    expect(() =>
      createJwksKeyStore({
        jwksUri: "https://evil.test/jwks",
        cache: { allowedHosts: ["issuer.test"] },
      }),
    ).toThrow(KeyResolutionError);
  });

  test("redirect following requires an allowed host list", async () => {
    expect(() =>
      createJwksKeyStore({
        jwksUri: "https://issuer.test/jwks",
        cache: { allowRedirects: true },
      }),
    ).toThrow(KeyResolutionError);
  });

  test("rejects redirect downgrade to http by default", async () => {
    const signed = await signTestJwt();
    const response = new Response(JSON.stringify(signed.jwks!));
    Object.defineProperty(response, "url", {
      value: "http://issuer.test/redirected-jwks",
    });
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: async () => response,
      cache: { allowRedirects: true, allowedHosts: ["issuer.test"] },
    });

    await expect(store.resolve(signed.kid, "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });

  test("rejects redirect-enabled responses when the final URL cannot be validated", async () => {
    const signed = await signTestJwt();
    const response = new Response(JSON.stringify(signed.jwks!));
    Object.defineProperty(response, "url", { value: "" });
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: async () => response,
      cache: { allowRedirects: true, allowedHosts: ["issuer.test"] },
    });

    await expect(store.resolve(signed.kid, "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });

  test("a fetch timeout surfaces as an unhealthy key store", async () => {
    const fetchLike = (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { timeoutMs: 10 },
    });
    const health = await store.health();
    expect(health.status).toBe("unhealthy");
  });

  test("a slow JWKS body is covered by the fetch timeout", async () => {
    const signed = await signTestJwt();
    const fetchLike = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            // Keep the body open forever; the key store timeout must abort the
            // body read rather than only timing out response headers.
          },
        }),
      );
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { timeoutMs: 10 },
    });

    await expect(store.resolve(signed.kid, "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });

  test("rejects a JWKS response larger than the size cap", async () => {
    const signed = await signTestJwt();
    const big = JSON.stringify(signed.jwks!) + " ".repeat(2_000);
    const fetchLike = async (): Promise<Response> =>
      new Response(big, { headers: { "content-length": String(big.length) } });
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { maxResponseBytes: 512 },
    });
    await expect(store.resolve(signed.kid, "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });

  test("does not refetch for a flood of distinct unknown kids within the throttle window", async () => {
    const signed = await signTestJwt({ kid: "k1" });
    let fetches = 0;
    const fetchLike = async (): Promise<Response> => {
      fetches++;
      return new Response(JSON.stringify(signed.jwks!));
    };
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { minRefetchIntervalMs: 60_000 },
    });
    await store.resolve("k1", "RS256");
    fetches = 0;

    for (let i = 0; i < 10; i++) {
      await store.resolve(`unknown-${i}`, "RS256").catch(() => undefined);
    }
    // First unknown kid forces one refetch; the rest are throttled.
    expect(fetches).toBe(1);
  });

  test("a failing JWKS endpoint is not hammered by a flood of unknown kids", async () => {
    const signed = await signTestJwt({ kid: "k1" });
    let fetches = 0;
    const fetchLike = async (): Promise<Response> => {
      fetches++;
      if (fetches === 1) return new Response(JSON.stringify(signed.jwks!));
      // Every forced refetch after priming fails (IdP outage).
      return new Response("down", { status: 503 });
    };
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { minRefetchIntervalMs: 60_000 },
    });
    await store.resolve("k1", "RS256");
    fetches = 0;

    for (let i = 0; i < 10; i++) {
      await store.resolve(`unknown-${i}`, "RS256").catch(() => undefined);
    }
    // Throttle advances even though the forced refetch failed, so the outage
    // does not turn into a per-request fetch amplifier.
    expect(fetches).toBe(1);
  });

  test("caps a JWKS response that omits content-length", async () => {
    const signed = await signTestJwt();
    const big = JSON.stringify(signed.jwks!) + " ".repeat(4_000);
    const fetchLike = async (): Promise<Response> =>
      // ReadableStream body with no content-length header.
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
      );
    const store = createJwksKeyStore({
      jwksUri: "https://issuer.test/jwks",
      fetch: fetchLike,
      cache: { maxResponseBytes: 512 },
    });
    await expect(store.resolve(signed.kid, "RS256")).rejects.toThrow(
      KeyResolutionError,
    );
  });
});

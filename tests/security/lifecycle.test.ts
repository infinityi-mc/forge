import { describe, expect, test } from "bun:test";
import { securityHealthComponent } from "../../src/security";
import type { KeyStore } from "../../src/security/jwks";
import type { Component } from "../../src/lifecycle";

function keyStoreWithHealth(
  status: "healthy" | "unhealthy",
  message?: string,
): Pick<KeyStore, "health"> {
  return {
    async health() {
      return status === "healthy"
        ? { status, checkedAt: new Date(0) }
        : { status, message: message ?? "down", checkedAt: new Date(0) };
    },
  };
}

describe("security lifecycle component", () => {
  test("mirrors a healthy key store and is a forge/lifecycle Component", async () => {
    const component = securityHealthComponent(keyStoreWithHealth("healthy"));
    // Structural assignment proves no forge/lifecycle import is required.
    const asComponent: Component = component;

    expect(asComponent.name).toBe("security.jwks");
    const result = await asComponent.healthcheck!({
      signal: new AbortController().signal,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    expect(result.status).toBe("healthy");
    expect(result.data?.checkedAt).toBe(new Date(0).toISOString());
  });

  test("surfaces an unhealthy key store with its message as detail", async () => {
    const component = securityHealthComponent(
      keyStoreWithHealth("unhealthy", "JWKS fetch failed"),
      { name: "idp" },
    );

    expect(component.name).toBe("idp");
    const result = await component.healthcheck();
    expect(result.status).toBe("unhealthy");
    expect(result.detail).toBe("JWKS fetch failed");
  });

  test("degraded option downgrades unhealthy to degraded for readiness", async () => {
    const component = securityHealthComponent(
      keyStoreWithHealth("unhealthy"),
      { degraded: true },
    );

    const result = await component.healthcheck();
    expect(result.status).toBe("degraded");
  });
});

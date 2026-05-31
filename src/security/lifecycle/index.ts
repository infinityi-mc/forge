import type { KeyStore } from "../jwks/types";

/**
 * Structural `forge/lifecycle` seam. The verifier's JWKS {@link KeyStore}
 * exposes `health()`, so it can be registered as a lifecycle component whose
 * readiness reflects IdP reachability — without a hard import of
 * `forge/lifecycle` (we only mirror its `Component` shape).
 */

export type LifecycleHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface LifecycleHealthResult {
  readonly status: LifecycleHealthStatus;
  readonly detail?: string;
  readonly data?: Record<string, unknown>;
}

export interface LifecycleComponent {
  readonly name: string;
  healthcheck(): Promise<LifecycleHealthResult>;
}

export interface SecurityHealthComponentOptions {
  /** Component name surfaced in lifecycle health output. Default `security.jwks`. */
  readonly name?: string;
  /**
   * Treat an unhealthy key store as `degraded` rather than `unhealthy` — use
   * when the IdP being unreachable should not fail readiness outright.
   */
  readonly degraded?: boolean;
}

/**
 * Adapt a JWKS {@link KeyStore} into a `forge/lifecycle` health component.
 * The component's readiness mirrors `KeyStore.health()` — i.e. IdP/JWKS
 * reachability.
 *
 * ```ts
 * boot({ components: [securityHealthComponent(keyStore)] });
 * ```
 */
export function securityHealthComponent(
  keyStore: Pick<KeyStore, "health">,
  options: SecurityHealthComponentOptions = {},
): LifecycleComponent {
  const name = options.name ?? "security.jwks";
  return {
    name,
    async healthcheck(): Promise<LifecycleHealthResult> {
      const result = await keyStore.health();
      const status =
        result.status === "unhealthy" && options.degraded === true
          ? "degraded"
          : result.status;
      return {
        status,
        ...(result.message === undefined ? {} : { detail: result.message }),
        data: { checkedAt: result.checkedAt.toISOString() },
      };
    },
  };
}

import type { Secret } from "../../config/secret";
import type { JwsAlgorithm } from "../jwt/types";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PipelineLike {
  execute<T>(op: () => Promise<T> | T): Promise<T>;
}

export interface JsonWebKey {
  readonly kty?: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly key_ops?: string[];
  readonly crv?: string;
  readonly [key: string]: unknown;
}

export type JsonWebKeySet = {
  readonly keys: readonly JsonWebKey[];
};

export type KeySource =
  | {
      readonly jwksUri: string;
      readonly cache?: JwksCacheOptions;
      readonly fetch?: FetchLike;
    }
  | { readonly jwks: JsonWebKeySet }
  | { readonly hmacSecret: Secret<string> };

export interface JwksCacheOptions {
  readonly ttlMs?: number;
  readonly minRefetchIntervalMs?: number;
  readonly resilience?: PipelineLike;
  /**
   * How long an unresolved `(kid, alg)` miss is remembered so a flood of
   * unknown `kid`s cannot each force a JWKS refetch. Defaults to
   * `minRefetchIntervalMs`.
   */
  readonly negativeKidTtlMs?: number;
  /** Outbound JWKS fetch timeout in ms (AbortController). Defaults to 5000. */
  readonly timeoutMs?: number;
  /** Max JWKS response size in bytes, rejected before JSON parse. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** If set, the JWKS host (and any redirect target) must be in this list. */
  readonly allowedHosts?: readonly string[];
  /** Allow `http:` JWKS URIs. Defaults to false (HTTPS required). */
  readonly allowInsecureHttp?: boolean;
  /**
   * Follow HTTP redirects when fetching JWKS. Defaults to false (rejected).
   * Requires `allowedHosts` so redirect targets can be revalidated.
   */
  readonly allowRedirects?: boolean;
}

export interface HealthResult {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly message?: string;
  readonly checkedAt: Date;
}

export interface KeyStore {
  resolve(kid: string | undefined, alg: JwsAlgorithm): Promise<CryptoKey>;
  health(): Promise<HealthResult>;
}

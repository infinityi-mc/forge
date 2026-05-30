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

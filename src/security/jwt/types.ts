import type { Secret } from "../../config/secret";
import type {
  Clock,
  LoggerLike,
  SecurityTelemetry,
} from "../types";
import type { KeySource } from "../jwks/types";

export type JwsAlgorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA"
  | "HS256"
  | "HS384"
  | "HS512";

export interface ClaimMapping {
  readonly roles?: string;
  readonly scopes?: string;
  readonly tenant?: string;
}

export interface JwtVerifierOptions {
  readonly keys: KeySource;
  readonly algorithms: readonly JwsAlgorithm[];
  readonly issuer: string | readonly string[];
  readonly audience: string | readonly string[];
  readonly clockToleranceMs?: number;
  readonly claimMap?: ClaimMapping;
  readonly clock?: Clock;
  readonly telemetry?: SecurityTelemetry;
  readonly logger?: LoggerLike;
}

export interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly [key: string]: unknown;
}

export type HmacKeySource = { readonly hmacSecret: Secret<string> };


import type { Secret } from "../../config/secret";
import type { AuditLogger } from "../audit/types";
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

/**
 * Upper bounds applied to an inbound compact JWS before any base64url decode
 * or `JSON.parse`, so attacker-controlled tokens cannot force large
 * allocations. All limits are in bytes; base64url is ASCII so encoded lengths
 * equal byte lengths.
 */
export interface JwtSizeLimits {
  /** Max length of the whole compact token. */
  readonly maxTokenBytes?: number;
  /** Max length of the encoded header segment. */
  readonly maxHeaderBytes?: number;
  /** Max length of the encoded payload segment. */
  readonly maxPayloadBytes?: number;
  /** Max decoded size of either JSON segment before `JSON.parse`. */
  readonly maxDecodedJsonBytes?: number;
}

export interface JwtVerifierOptions {
  readonly keys: KeySource;
  readonly algorithms: readonly JwsAlgorithm[];
  readonly issuer: string | readonly string[];
  readonly audience: string | readonly string[];
  readonly clockToleranceMs?: number;
  readonly claimMap?: ClaimMapping;
  /** Token/segment size limits enforced before decode. Safe defaults apply. */
  readonly limits?: JwtSizeLimits;
  readonly clock?: Clock;
  readonly telemetry?: SecurityTelemetry;
  readonly logger?: LoggerLike;
  /** Always-on audit logger: records token verification + key rotation. */
  readonly audit?: AuditLogger;
}

export interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly [key: string]: unknown;
}

export type HmacKeySource = { readonly hmacSecret: Secret<string> };


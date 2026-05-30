import type { JwsAlgorithm } from "./jwt/types";

/** The typed result of successful authentication. Explicit value, no globals. */
export interface Principal {
  /** Stable subject id from the `sub` claim. */
  readonly subject: string;
  /** Issuer that vouched for this principal. */
  readonly issuer: string;
  /** Audience values the token was minted for. */
  readonly audience: readonly string[];
  /** Roles/groups extracted via claim mapping. */
  readonly roles: readonly string[];
  /** OAuth scopes extracted from `scope` / `scp` style claims. */
  readonly scopes: readonly string[];
  /** Tenant id, when configured. */
  readonly tenant?: string;
  /** Full validated claim set for custom policies. */
  readonly claims: Readonly<Record<string, unknown>>;
  /** Token lifetime bounds, already validated. */
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface VerifyOptions {
  readonly clockToleranceMs?: number;
}

export interface TokenVerifier {
  verify(token: string, opts?: VerifyOptions): Promise<Principal>;
}

export interface Clock {
  now(): number;
}

export interface LoggerLike {
  debug?(message: string, attributes?: Record<string, unknown>): void;
  info?(message: string, attributes?: Record<string, unknown>): void;
  warn?(message: string, attributes?: Record<string, unknown>): void;
  error?(message: string, attributes?: Record<string, unknown>): void;
}

export interface CounterLike {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface HistogramLike {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface MeterLike {
  createCounter?(
    name: string,
    options?: { description?: string; unit?: string },
  ): CounterLike;
  createHistogram?(
    name: string,
    options?: { description?: string; unit?: string },
  ): HistogramLike;
}

export interface SecurityTelemetry {
  readonly meter?: MeterLike;
}

export interface SecurityObservation {
  readonly algorithm?: JwsAlgorithm;
  readonly issuer?: string;
  readonly outcome: "success" | "failure";
  readonly reason?: string;
  readonly durationMs: number;
}


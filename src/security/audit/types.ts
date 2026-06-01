import type { Secret } from "../../config/secret";
import type { Clock, LoggerLike, Principal } from "../types";

/** Outcome of an audited security decision. */
export type AuditOutcome = "success" | "failure" | "denied" | "error";

/** Non-sensitive identity summary embedded in an {@link AuditEvent}. */
export type AuditPrincipal = Pick<Principal, "subject" | "issuer" | "tenant">;

/** The resource a decision was made about. */
export interface AuditResource {
  readonly type: string;
  readonly id?: string;
}

/**
 * A structured, redaction-aware record of a security-relevant decision.
 *
 * `action` is the event's taxonomy name (e.g. `"auth.token.verified"`,
 * `"authz.denied"`) — consistent across the module so audit pipelines can
 * alert on it. Token/secret material is **never** present.
 */
export interface AuditEvent {
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly principal?: AuditPrincipal;
  readonly resource?: AuditResource;
  /** Deny/error reason category (never secrets). */
  readonly reason?: string;
  readonly at: Date;
  /** From `forge/telemetry` context / `x-request-id`, when available. */
  readonly correlationId?: string;
  readonly metadata?: Record<string, unknown>;
  /** Hash of the previous record — present only when `tamperEvident`. */
  readonly previousHash?: string;
  /** Hash of this record — present only when `tamperEvident`. */
  readonly hash?: string;
}

/**
 * Caller-supplied fields. `at` defaults to the logger clock; `correlationId`
 * falls back to {@link AuditOptions.correlation}; `hash`/`previousHash` are
 * filled by the logger when tamper-evidence is enabled.
 */
export type AuditEventInput = Omit<
  AuditEvent,
  "at" | "hash" | "previousHash"
> & {
  readonly at?: Date;
};

/** Where audit records are written. BYO durable adapters implement this. */
export interface AuditSink {
  record(event: AuditEvent): Promise<void> | void;
}

/** Records security decisions; fills `at`, correlation, and chain links. */
export interface AuditLogger {
  record(event: AuditEventInput): Promise<void>;
}

export interface AuditOptions {
  /** Where records go (BYO). */
  readonly sink: AuditSink;
  /** Dotted `metadata` paths whose values are replaced before write. */
  readonly redact?: readonly string[];
  /** Replacement token for redacted values (defaults to `"[REDACTED]"`). */
  readonly redactReplacement?: string;
  /** Hash-chain each record to the previous one for tamper-evidence. */
  readonly tamperEvident?: boolean;
  /**
   * Server-side secret. Requires `tamperEvident: true`; otherwise
   * `createAuditLogger` throws. When set, chain hashes are HMAC-SHA-256 keyed
   * with this secret, so an attacker who rewrites the store cannot recompute a
   * valid chain without it.
   */
  readonly signingSecret?: Secret<string>;
  /** Pulls a correlation id (traceId / `x-request-id`) at record time. */
  readonly correlation?: () => string | undefined;
  readonly clock?: Clock;
}

export interface MemoryAuditSink extends AuditSink {
  readonly events: readonly AuditEvent[];
  clear(): void;
}

export interface LogSinkOptions {
  readonly logger: LoggerLike;
  /** Replacement token used by {@link AuditOptions.redact}. */
  readonly redactReplacement?: string;
}

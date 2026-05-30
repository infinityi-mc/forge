import type { Clock, LoggerLike, Principal } from "../types";

export type AuditEventType =
  | "authentication/success"
  | "authentication/failure"
  | "authorization/allow"
  | "authorization/deny"
  | (string & {});

export type AuditOutcome =
  | "success"
  | "failure"
  | "allow"
  | "deny";

export interface AuditPrincipal {
  readonly subject: string;
  readonly issuer: string;
  readonly tenant?: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
}

export type AuditRequestContext = Readonly<Record<string, unknown>>;
export type AuditAttributes = Readonly<Record<string, unknown>>;
export type AuditResource = string | number | boolean | AuditAttributes;

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: Date;
  readonly type: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly principal?: AuditPrincipal;
  readonly action?: string;
  readonly resource?: AuditResource;
  readonly reason?: string;
  readonly request?: AuditRequestContext;
  readonly attributes?: AuditAttributes;
}

export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp">;

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export interface AuditRecorder {
  record(event: AuditEventInput): Promise<void>;
}

export interface AuditRecorderOptions {
  readonly sink: AuditSink;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly logger?: LoggerLike;
}

export interface MemoryAuditSink extends AuditSink {
  readonly events: readonly AuditEvent[];
  clear(): void;
}

export function createAuditRecorder(
  options: AuditRecorderOptions,
): AuditRecorder {
  const clock = options.clock ?? { now: () => Date.now() };
  const idGenerator = options.idGenerator ?? defaultIdGenerator;

  return {
    async record(input) {
      const event: AuditEvent = Object.freeze({
        ...input,
        id: idGenerator(),
        timestamp: new Date(clock.now()),
      });
      try {
        await options.sink.record(event);
      } catch (error) {
        options.logger?.warn?.("security audit recording failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    },
  };
}

export function memoryAuditSink(): MemoryAuditSink {
  const events: AuditEvent[] = [];
  return {
    get events() {
      return events;
    },
    record(event) {
      events.push(event);
    },
    clear() {
      events.length = 0;
    },
  };
}

export function auditPrincipal(principal: Principal): AuditPrincipal {
  return Object.freeze({
    subject: principal.subject,
    issuer: principal.issuer,
    ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
    roles: Object.freeze([...principal.roles]),
    scopes: Object.freeze([...principal.scopes]),
  });
}

function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

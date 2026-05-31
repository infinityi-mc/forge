import { AuditError } from "../errors";
import type { Clock, Principal } from "../types";
import { hashAuditEvent } from "./chain";
import type {
  AuditEvent,
  AuditEventInput,
  AuditLogger,
  AuditOptions,
  AuditPrincipal,
  AuditSink,
  LogSinkOptions,
  MemoryAuditSink,
} from "./types";

export type {
  AuditEvent,
  AuditEventInput,
  AuditLogger,
  AuditOptions,
  AuditOutcome,
  AuditPrincipal,
  AuditResource,
  AuditSink,
  LogSinkOptions,
  MemoryAuditSink,
} from "./types";
export { hashAuditEvent, verifyAuditChain } from "./chain";

const REDACTED = "[REDACTED]";
const realClock: Clock = { now: () => Date.now() };

/**
 * Build an always-on {@link AuditLogger}. Records are written to the BYO
 * {@link AuditSink} after optional metadata redaction and optional
 * tamper-evident hash chaining. A sink failure surfaces as an
 * {@link AuditError} (callers decide whether to swallow it — the HTTP seam
 * does, so auditing never alters an auth decision).
 *
 * Records are serialized so the hash chain (and in-memory ordering) stays
 * deterministic under concurrent callers.
 */
export function createAuditLogger(options: AuditOptions): AuditLogger {
  const clock = options.clock ?? realClock;
  const redactPaths = options.redact ?? [];
  const tamperEvident = options.tamperEvident === true;
  let previousHash: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  async function run(input: AuditEventInput): Promise<void> {
    const correlationId = input.correlationId ?? options.correlation?.();
    let event: AuditEvent = {
      action: input.action,
      outcome: input.outcome,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      at: input.at ?? new Date(clock.now()),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: redactMetadata(input.metadata, redactPaths) }),
    };

    let hash: string | undefined;
    if (tamperEvident) {
      if (previousHash !== undefined) event = { ...event, previousHash };
      hash = await hashAuditEvent(event);
      event = { ...event, hash };
    }

    try {
      await options.sink.record(event);
    } catch (error) {
      throw new AuditError("audit sink failed to record event", {
        cause: error,
      });
    }

    // Only advance the chain after the event is durably recorded, so a sink
    // failure does not leave subsequent events pointing at an unpersisted hash.
    if (hash !== undefined) previousHash = hash;
  }

  return {
    record(input) {
      const result = tail.then(() => run(input));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** Default structured-log sink: writes each record via the injected logger. */
export function logSink(options: LogSinkOptions): AuditSink {
  const logger = options.logger;
  return {
    record(event) {
      const attributes = serialize(event);
      const message = `security.audit ${event.action}`;
      if (event.outcome === "success") {
        logger.info?.(message, attributes);
      } else {
        logger.warn?.(message, attributes);
      }
    },
  };
}

/** In-memory sink for tests; exposes recorded `events`. */
export function memorySink(): MemoryAuditSink {
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

/** Testing alias for {@link memorySink}. */
export const memoryAuditSink = memorySink;

/** Reduce a {@link Principal} to the non-sensitive identity summary. */
export function auditPrincipal(
  principal: Pick<Principal, "subject" | "issuer" | "tenant">,
): AuditPrincipal {
  return {
    subject: principal.subject,
    issuer: principal.issuer,
    ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
  };
}

function serialize(event: AuditEvent): Record<string, unknown> {
  return { ...event, at: event.at.toISOString() };
}

/**
 * Replace the value at each dotted `metadata` path with `[REDACTED]`,
 * mirroring the `forge/telemetry/log` redact contract. Returns a shallow
 * clone so the caller's object is not mutated.
 */
function redactMetadata(
  metadata: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  if (paths.length === 0) return metadata;
  let out: Record<string, unknown> = metadata;
  let cloned = false;
  for (const path of paths) {
    if (!hasPath(out, path)) continue;
    if (!cloned) {
      out = structuredClone(metadata);
      cloned = true;
    }
    setPath(out, path, REDACTED);
  }
  return out;
}

function hasPath(root: Record<string, unknown>, path: string): boolean {
  const segments = path.split(".");
  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) return false;
    if (!(segment in (cursor as Record<string, unknown>))) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

function setPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (last === undefined) return;
  let cursor: Record<string, unknown> = root;
  for (const segment of segments) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null) return;
    cursor = next as Record<string, unknown>;
  }
  cursor[last] = value;
}

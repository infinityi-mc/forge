import type { AuditEvent } from "./types";

/**
 * Optional tamper-evident hash chaining: each record carries the hash of the
 * previous one plus its own hash over its content, so a deleted or edited
 * record breaks the chain and is detectable after the fact.
 */

/**
 * Stable serialization of the logged fields (the `hash` itself is excluded so
 * a record can hash over its own `previousHash` link).
 */
function canonical(event: AuditEvent): string {
  return JSON.stringify({
    action: event.action,
    outcome: event.outcome,
    principal: event.principal ?? null,
    resource: event.resource ?? null,
    reason: event.reason ?? null,
    at: event.at.toISOString(),
    correlationId: event.correlationId ?? null,
    metadata: event.metadata ?? null,
    previousHash: event.previousHash ?? null,
  });
}

/** SHA-256 (hex) of an event's canonical content, excluding its own `hash`. */
export async function hashAuditEvent(event: AuditEvent): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(event));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

/**
 * Verify a hash chain produced with `tamperEvident: true`. Returns `true` when
 * every record's `hash` recomputes and links to its predecessor's `hash`.
 */
export async function verifyAuditChain(
  events: readonly AuditEvent[],
): Promise<boolean> {
  let previousHash: string | undefined;
  for (const event of events) {
    if (event.hash === undefined) return false;
    if (event.previousHash !== previousHash) return false;
    const { hash: _hash, ...rest } = event;
    const recomputed = await hashAuditEvent(rest as AuditEvent);
    if (recomputed !== event.hash) return false;
    previousHash = event.hash;
  }
  return true;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

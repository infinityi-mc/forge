import type { Secret } from "../../config/secret";
import type { AuditEvent } from "./types";

const HMAC_KEY_CACHE = new WeakMap<Secret<string>, Promise<CryptoKey>>();

/**
 * Optional tamper-evident hash chaining: each record carries the hash of the
 * previous one plus its own hash over its content, so a deleted or edited
 * record breaks the chain and is detectable after the fact.
 *
 * NOTE: plain (unsigned) chaining only proves *internal consistency*. An
 * attacker who can rewrite the entire audit store can recompute every hash and
 * the chain will still verify. For tamper-evidence against such a writer, pass
 * a server-side `Secret<string>` (switches to HMAC-SHA-256, which the attacker
 * cannot reproduce without the secret) and/or anchor the chain head in an
 * external append-only location and pass it as `expectedHead` to
 * {@link verifyAuditChain}.
 */

/** Options controlling {@link verifyAuditChain}. */
export interface VerifyAuditChainOptions {
  /** When set, hashes are verified as HMAC-SHA-256 keyed with this secret. */
  readonly secret?: Secret<string>;
  /**
   * Externally-anchored hash of the last expected record. When provided, the
   * final record's `hash` must equal it, so a fully-recomputed chain still
   * fails verification.
   */
  readonly expectedHead?: string;
}

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

/**
 * Hash (hex) of an event's canonical content, excluding its own `hash`. Uses
 * SHA-256 by default, or HMAC-SHA-256 when a `secret` is supplied.
 */
export async function hashAuditEvent(
  event: AuditEvent,
  secret?: Secret<string>,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(event));
  if (secret !== undefined) {
    const key = await importedHmacKey(secret);
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(bytes),
    );
    return toHex(signature);
  }
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return toHex(digest);
}

/**
 * Verify a hash chain produced with `tamperEvident: true`. Returns `true` when
 * every record's `hash` recomputes and links to its predecessor's `hash`. Pass
 * `secret` to verify HMAC-signed chains and/or `expectedHead` to assert the
 * chain ends at an externally-anchored head.
 */
export async function verifyAuditChain(
  events: readonly AuditEvent[],
  options?: VerifyAuditChainOptions,
): Promise<boolean> {
  let previousHash: string | undefined;
  for (const event of events) {
    if (event.hash === undefined) return false;
    if (event.previousHash !== previousHash) return false;
    const { hash: _hash, ...rest } = event;
    const recomputed = await hashAuditEvent(
      rest as AuditEvent,
      options?.secret,
    );
    if (recomputed !== event.hash) return false;
    previousHash = event.hash;
  }
  if (
    options?.expectedHead !== undefined &&
    previousHash !== options.expectedHead
  ) {
    return false;
  }
  return true;
}

function importedHmacKey(secret: Secret<string>): Promise<CryptoKey> {
  let key = HMAC_KEY_CACHE.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      "raw",
      toArrayBuffer(new TextEncoder().encode(secret.unwrap())),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    HMAC_KEY_CACHE.set(secret, key);
  }
  return key;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

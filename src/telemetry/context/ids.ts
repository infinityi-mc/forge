/**
 * Trace and span id generation + validation, following the W3C Trace
 * Context spec.
 *
 * - Trace ids are 16 bytes (32 lower-case hex characters).
 * - Span ids are 8 bytes (16 lower-case hex characters).
 * - The all-zero id is reserved as "invalid" and rejected.
 *
 * @module
 */

import { randomBytes } from "node:crypto";

/** 32-character all-zero string — reserved as "invalid trace id". */
export const INVALID_TRACE_ID = "0".repeat(32);

/** 16-character all-zero string — reserved as "invalid span id". */
export const INVALID_SPAN_ID = "0".repeat(16);

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/** Generate a fresh random 16-byte trace id as 32 lower-case hex chars. */
export function genTraceId(): string {
  // randomBytes never returns all-zero in practice; the spec only requires
  // we don't *emit* the invalid id, not that we re-roll on collision.
  return randomBytes(16).toString("hex");
}

/** Generate a fresh random 8-byte span id as 16 lower-case hex chars. */
export function genSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Whether `id` is a syntactically valid, non-zero trace id (32 hex chars).
 * The W3C spec treats the all-zero id as invalid even though it matches
 * the character class.
 */
export function isValidTraceId(id: string): boolean {
  return TRACE_ID_RE.test(id) && id !== INVALID_TRACE_ID;
}

/**
 * Whether `id` is a syntactically valid, non-zero span id (16 hex chars).
 */
export function isValidSpanId(id: string): boolean {
  return SPAN_ID_RE.test(id) && id !== INVALID_SPAN_ID;
}

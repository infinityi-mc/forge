/**
 * Envelope ⇄ wire-record mapping shared by the bus and the consumer.
 *
 * Transports are dumb byte pipes ({@link TransportRecord}), so any
 * envelope metadata without a first-class record field travels as a
 * reserved `x-forge-*` header. Centralizing the mapping here keeps the
 * publish and consume sides in lock-step.
 *
 * @module
 */

import type { Codec } from "./codec";
import type { Message, TransportDelivery, TransportRecord } from "./types";

/** Reserved header carrying the producer's `occurredAt` as an ISO string. */
export const OCCURRED_AT_HEADER = "x-forge-occurred-at";

/** All reserved header keys, stripped from the consumer-facing view. */
const RESERVED_HEADERS: readonly string[] = [OCCURRED_AT_HEADER];

/** Fully-resolved envelope the bus hands to {@link toRecord}. */
export interface OutgoingMessage {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly headers: Record<string, string>;
  readonly occurredAt: Date;
}

/** Encode a resolved envelope into a wire record. */
export function toRecord(message: OutgoingMessage, codec: Codec): TransportRecord {
  return {
    type: message.type,
    id: message.id,
    headers: {
      ...message.headers,
      [OCCURRED_AT_HEADER]: message.occurredAt.toISOString(),
    },
    body: codec.encode(message.payload),
  };
}

/** Decode a delivery back into a {@link Message}. */
export function toMessage<T = unknown>(
  delivery: TransportDelivery,
  codec: Codec,
): Message<T> {
  const { record, attempt } = delivery;
  const payload = codec.decode(record.body) as T;

  const occurredHeader = record.headers[OCCURRED_AT_HEADER];
  const parsed = occurredHeader ? new Date(occurredHeader) : undefined;
  const occurredAt =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();

  const headers: Record<string, string> = {};
  for (const key of Object.keys(record.headers)) {
    if (RESERVED_HEADERS.includes(key)) continue;
    const value = record.headers[key];
    if (value !== undefined) headers[key] = value;
  }

  return {
    id: record.id,
    type: record.type,
    payload,
    headers,
    occurredAt,
    attempt,
  };
}

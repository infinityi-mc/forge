/**
 * W3C Trace Context + Baggage propagation.
 *
 * Inject and extract context from carrier objects (typically HTTP
 * headers, but the carrier interface is generic so it also works for
 * message queues, gRPC metadata, etc.).
 *
 * Spec references:
 * - https://www.w3.org/TR/trace-context/
 * - https://www.w3.org/TR/baggage/
 *
 * @module
 */

import { isValidSpanId, isValidTraceId } from "./ids";
import { TRACE_FLAGS, type TelemetryContext } from "./types";

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";
const BAGGAGE_HEADER = "baggage";

/**
 * Read/write interface used to inject context into and extract context
 * from a transport-specific carrier (HTTP headers, AMQP properties,
 * gRPC metadata, …).
 *
 * Keys are case-insensitive HTTP-header-style names. Implementations
 * are responsible for lower-casing if their carrier is case-sensitive.
 */
export interface TextMapCarrier {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * Wrap a plain object as a {@link TextMapCarrier}. Useful for working
 * with `Headers`-shaped or `Record<string, string>` carriers.
 *
 * Lookup is case-insensitive; writes preserve the case of `key`.
 */
export function objectCarrier(
  store: Record<string, string | undefined>,
): TextMapCarrier {
  return {
    get(key) {
      const direct = store[key];
      if (direct !== undefined) return direct;
      const lower = key.toLowerCase();
      for (const k of Object.keys(store)) {
        if (k.toLowerCase() === lower) return store[k];
      }
      return undefined;
    },
    set(key, value) {
      store[key] = value;
    },
  };
}

/**
 * Inject the active context into `carrier` as W3C `traceparent` (and
 * optionally `tracestate` and `baggage`) headers.
 *
 * Returns the carrier for chaining.
 */
export function inject(
  ctx: TelemetryContext,
  carrier: TextMapCarrier,
): TextMapCarrier {
  carrier.set(TRACEPARENT_HEADER, formatTraceparent(ctx));
  if (ctx.traceState !== undefined && ctx.traceState.length > 0) {
    carrier.set(TRACESTATE_HEADER, ctx.traceState);
  }
  if (Object.keys(ctx.baggage).length > 0) {
    carrier.set(BAGGAGE_HEADER, formatBaggage(ctx.baggage));
  }
  return carrier;
}

/**
 * Extract a {@link TelemetryContext} from `carrier`. Returns `undefined`
 * when the carrier has no valid `traceparent`.
 *
 * Invalid `tracestate` and `baggage` headers are dropped silently — the
 * spec is explicit that propagators MUST NOT fail extraction because of
 * malformed companion headers.
 */
export function extract(carrier: TextMapCarrier): TelemetryContext | undefined {
  const traceparent = carrier.get(TRACEPARENT_HEADER);
  if (traceparent === undefined) return undefined;
  const parsed = parseTraceparent(traceparent);
  if (parsed === undefined) return undefined;

  const traceState = carrier.get(TRACESTATE_HEADER);
  const baggageHeader = carrier.get(BAGGAGE_HEADER);
  const baggage = baggageHeader ? parseBaggage(baggageHeader) : {};

  const ctx: TelemetryContext = {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.traceFlags,
    baggage,
  };
  if (traceState !== undefined && traceState.length > 0) {
    (ctx as { traceState?: string }).traceState = traceState;
  }
  return ctx;
}

interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/**
 * Parse a W3C `traceparent` header value. Returns `undefined` for any
 * malformed or unsupported value (unknown version, invalid ids, etc.).
 *
 * Format: `<version>-<trace-id>-<span-id>-<trace-flags>`.
 */
export function parseTraceparent(value: string): ParsedTraceparent | undefined {
  const parts = value.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flagsStr] = parts as [
    string,
    string,
    string,
    string,
  ];

  // Per spec: version "ff" is invalid; any other 2-hex version that we
  // don't recognize is forward-compatibly treated like version "00".
  if (!/^[0-9a-f]{2}$/.test(version) || version === "ff") return undefined;
  if (!isValidTraceId(traceId)) return undefined;
  if (!isValidSpanId(spanId)) return undefined;
  if (!/^[0-9a-f]{2}$/.test(flagsStr)) return undefined;

  const traceFlags = parseInt(flagsStr, 16);
  if (Number.isNaN(traceFlags)) return undefined;

  return { traceId, spanId, traceFlags };
}

/**
 * Serialize a context as a W3C `traceparent` value. Always emits
 * version `00` since that's the only version this implementation
 * generates.
 */
export function formatTraceparent(ctx: TelemetryContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Parse a W3C `baggage` header value into a `Record<string,string>`.
 * Malformed entries are dropped silently.
 *
 * Format: `key1=value1,key2=value2;property=ignored`.
 * Per spec, the `;property=…` suffix is metadata and is currently
 * discarded by this implementation.
 */
export function parseBaggage(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const semi = entry.indexOf(";");
    const kv = semi === -1 ? entry : entry.slice(0, semi);
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const key = kv.slice(0, eq).trim();
    const rawVal = kv.slice(eq + 1).trim();
    if (key.length === 0) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawVal);
    } catch {
      continue;
    }
    out[key] = decoded;
  }
  return out;
}

/**
 * Serialize a baggage map to a `baggage` header value. Keys and values
 * are percent-encoded per RFC 7230 token rules (we delegate to
 * `encodeURIComponent`, which is conservative but spec-compliant).
 */
export function formatBaggage(baggage: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(baggage)) {
    parts.push(`${encodeBaggageKey(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join(",");
}

function encodeBaggageKey(key: string): string {
  // Baggage keys per RFC 7230 token: alphanumerics + a small set of
  // punctuation. `encodeURIComponent` over-encodes some of those, but
  // collectors decode percent-encoded keys, so the round-trip is safe.
  return encodeURIComponent(key);
}

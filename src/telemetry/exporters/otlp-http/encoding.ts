/**
 * OTLP/JSON encoding helpers shared by the log/metric/trace exporters.
 *
 * Targets OTLP/HTTP JSON v1.x (see
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp). All numeric
 * timestamps are nanoseconds-since-epoch encoded as decimal strings
 * (OTLP requires int64 wire shape).
 *
 * @module
 */

import type { Resource } from "../../types";

/**
 * Encode a `Resource` into OTLP's `Resource` shape — attributes as
 * an array of `KeyValue`. Hoists `serviceName`/`serviceVersion`/
 * `environment` to `service.*` and `deployment.environment` attributes
 * per OTel semantic conventions.
 */
export function encodeResource(resource: Resource): {
  attributes: KeyValue[];
} {
  const attrs: KeyValue[] = [];
  attrs.push(kv("service.name", resource.serviceName));
  if (resource.serviceVersion !== undefined) {
    attrs.push(kv("service.version", resource.serviceVersion));
  }
  if (resource.environment !== undefined) {
    attrs.push(kv("deployment.environment", resource.environment));
  }
  if (resource.attributes) {
    for (const [k, v] of Object.entries(resource.attributes)) {
      attrs.push(kv(k, v));
    }
  }
  return { attributes: attrs };
}

/**
 * Encode a `Date` (or epoch ms number) as a nanoseconds-since-epoch
 * string. OTLP/JSON requires int64 fields to be transmitted as
 * strings to avoid JS precision loss.
 */
export function toNanos(d: Date | number): string {
  const ms = typeof d === "number" ? d : d.getTime();
  // 1 ms = 1_000_000 ns. We use BigInt to keep precision.
  return (BigInt(ms) * 1_000_000n).toString();
}

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } };

export function kv(key: string, value: unknown): KeyValue {
  return { key, value: anyValue(value) };
}

export function anyValue(value: unknown): AnyValue {
  if (value === null || value === undefined) return { stringValue: "" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { intValue: value.toString() };
    return { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return {
      kvlistValue: { values: Object.entries(obj).map(([k, v]) => kv(k, v)) },
    };
  }
  return { stringValue: String(value) };
}

export function encodeAttributes(
  attrs: Readonly<Record<string, unknown>>,
): KeyValue[] {
  return Object.entries(attrs).map(([k, v]) => kv(k, v));
}

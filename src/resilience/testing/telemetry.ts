/**
 * Standalone telemetry double for `forge/resilience` tests.
 *
 * The double implements the structural `ResilienceTelemetry` shape
 * directly so resilience tests do not need to import
 * `forge/telemetry/testing` just to assert emitted metrics or span
 * event-like records.
 *
 * @module
 */

import type { ResilienceTelemetry } from "../telemetry/instrumentation";

export type RecordedAttributeValue = string | number | boolean;
export type RecordedAttributes = Readonly<
  Record<string, RecordedAttributeValue>
>;

export type RecordedMetricKind =
  | "counter"
  | "up-down-counter"
  | "gauge"
  | "histogram";

export interface RecordedMetric {
  readonly name: string;
  readonly kind: RecordedMetricKind;
  readonly value: number;
  readonly attributes?: RecordedAttributes;
}

export interface RecordedSpanEvent {
  readonly name: string;
  readonly attributes?: RecordedAttributes;
}

export interface TestResilienceTelemetry {
  readonly telemetry: ResilienceTelemetry;
  readonly metrics: readonly RecordedMetric[];
  readonly spanEvents: readonly RecordedSpanEvent[];
  clear(): void;
}

interface MutableRecordedMetric {
  name: string;
  kind: RecordedMetricKind;
  value: number;
  attributes?: RecordedAttributes;
}

interface MutableRecordedSpanEvent {
  name: string;
  attributes?: RecordedAttributes;
}

interface DescriptorOptions {
  readonly description?: string;
  readonly unit?: string;
}

/**
 * Create an in-memory `ResilienceTelemetry` implementation.
 */
export function createTestResilienceTelemetry(): TestResilienceTelemetry {
  const metrics: MutableRecordedMetric[] = [];
  const spanEvents: MutableRecordedSpanEvent[] = [];
  let nextSpanId = 0;

  function pushMetric(
    name: string,
    kind: RecordedMetricKind,
    value: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const record: MutableRecordedMetric = { name, kind, value };
    if (attributes !== undefined) {
      record.attributes = { ...attributes };
    }
    metrics.push(record);
  }

  function descriptor(
    name: string,
    kind: RecordedMetricKind,
    options?: DescriptorOptions,
  ) {
    const value: {
      name: string;
      kind: RecordedMetricKind;
      description?: string;
      unit?: string;
    } = { name, kind };
    if (options?.description !== undefined) value.description = options.description;
    if (options?.unit !== undefined) value.unit = options.unit;
    return value;
  }

  function cleanAttributes(
    attributes?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): RecordedAttributes | undefined {
    if (attributes === undefined) return undefined;
    const entries = Object.entries(attributes).filter(([, value]) =>
      value !== undefined
    ) as Array<[string, RecordedAttributeValue]>;
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries) as RecordedAttributes;
  }

  function setSpanAttributes(
    event: MutableRecordedSpanEvent,
    attributes?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): void {
    const cleaned = cleanAttributes(attributes);
    if (cleaned === undefined) {
      delete event.attributes;
      return;
    }
    event.attributes = cleaned;
  }

  const telemetry: ResilienceTelemetry = {
    meter: {
      createCounter(name, options) {
        return {
          descriptor: descriptor(name, "counter", options),
          add(value, attributes) {
            pushMetric(name, "counter", value, attributes);
          },
        };
      },
      createUpDownCounter(name, options) {
        return {
          descriptor: descriptor(name, "up-down-counter", options),
          add(value, attributes) {
            pushMetric(name, "up-down-counter", value, attributes);
          },
        };
      },
      createGauge(name, options) {
        return {
          descriptor: descriptor(name, "gauge", options),
          record(value, attributes) {
            pushMetric(name, "gauge", value, attributes);
          },
        };
      },
      createHistogram(name, options) {
        return {
          descriptor: descriptor(name, "histogram", options),
          record(value, attributes) {
            pushMetric(name, "histogram", value, attributes);
          },
        };
      },
      async collect() {},
      async shutdown() {},
    },
    tracer: {
      startSpan(name, options) {
        const event: MutableRecordedSpanEvent = { name };
        setSpanAttributes(event, options?.attributes);
        spanEvents.push(event);

        const span = {
          traceId: "test-trace-id",
          spanId: `test-span-${++nextSpanId}`,
          isRecording: true,
          setAttribute(key: string, value: string | number | boolean) {
            setSpanAttributes(event, { ...event.attributes, [key]: value });
            return span;
          },
          setAttributes(
            attributes: Readonly<
              Record<string, string | number | boolean | undefined>
            >,
          ) {
            setSpanAttributes(event, { ...event.attributes, ...attributes });
            return span;
          },
          setStatus() {
            return span;
          },
          addEvent(
            eventName: string,
            attributes?: Readonly<
              Record<string, string | number | boolean | undefined>
            >,
          ) {
            const child: MutableRecordedSpanEvent = { name: eventName };
            setSpanAttributes(child, attributes);
            spanEvents.push(child);
            return span;
          },
          addLink() {
            return span;
          },
          end() {},
        };

        return span;
      },
      withSpan(name, fn, options) {
        const span = telemetry.tracer!.startSpan(name, options);
        try {
          return fn(span);
        } finally {
          span.end();
        }
      },
    },
  };

  return {
    telemetry,
    metrics,
    spanEvents,
    clear() {
      metrics.length = 0;
      spanEvents.length = 0;
    },
  };
}

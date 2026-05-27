/**
 * Conformance scenarios + assertion helpers for `forge/telemetry/trace`.
 *
 * Run `STANDARD_SPAN_SCENARIOS` against any `SpanExporter` to verify
 * it satisfies the same invariants as the shipped exporters: it
 * accepts every span kind, preserves attributes/events/links, doesn't
 * reject empty batches, and (when async) resolves cleanly.
 *
 * Helpers throw plain `Error`s on failure so they work under Bun's
 * built-in test runner, Vitest, Jest, or any other framework.
 *
 * @module
 */

import type { Resource } from "../../types";
import type {
  ReadableSpan,
  SpanAttributes,
  SpanExporter,
  SpanKind,
} from "../types";

export interface SpanConformanceScenario {
  name: string;
  run(exporter: SpanExporter): Promise<void> | void;
  assert(spans: readonly ReadableSpan[]): void;
}

const resource: Resource = {
  serviceName: "conformance",
  serviceVersion: "0.0.0",
  environment: "test",
};

const SAMPLE_TRACE = "0af7651916cd43dd8448eb211c80319c";
const SAMPLE_SPAN = "b7ad6b7169203331";

let spanCounter = 0;
function nextSpanId(): string {
  spanCounter = (spanCounter + 1) % 0xff_ff_ff_ff;
  return spanCounter.toString(16).padStart(16, "0");
}

function makeSpan(
  name: string,
  kind: SpanKind,
  attributes: SpanAttributes = {},
): ReadableSpan {
  const start = new Date(2025, 0, 1, 0, 0, 0);
  return {
    name,
    kind,
    traceId: SAMPLE_TRACE,
    spanId: nextSpanId(),
    parentSpanId: SAMPLE_SPAN,
    traceFlags: 1,
    startTime: start,
    endTime: new Date(start.getTime() + 100),
    status: { code: "unset" },
    attributes,
    events: [],
    links: [],
    resource,
  };
}

const kinds: readonly SpanKind[] = [
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
];

export const STANDARD_SPAN_SCENARIOS: readonly SpanConformanceScenario[] = [
  {
    name: "exporter accepts every span kind",
    async run(exporter) {
      await exporter.export(kinds.map((k) => makeSpan(`op.${k}`, k)));
    },
    assert(spans) {
      assertSpanCount(spans, kinds.length);
      for (let i = 0; i < kinds.length; i++) {
        assertSpanKind(spans[i]!, kinds[i]!);
      }
    },
  },
  {
    name: "exporter preserves attributes, events, and links",
    async run(exporter) {
      const span: ReadableSpan = {
        ...makeSpan("op", "server", { a: 1, b: "x", c: true }),
        events: [
          {
            name: "evt",
            timestamp: new Date(2025, 0, 1, 0, 0, 1),
            attributes: { k: 1 },
          },
        ],
        links: [
          {
            traceId: SAMPLE_TRACE,
            spanId: SAMPLE_SPAN,
            attributes: { rel: "parent" },
            traceFlags: 1,
          },
        ],
      };
      await exporter.export([span]);
    },
    assert(spans) {
      assertSpanCount(spans, 1);
      const s = spans[0]!;
      if (s.attributes.a !== 1 || s.attributes.b !== "x" || s.attributes.c !== true) {
        throw new Error(`attributes mangled: ${JSON.stringify(s.attributes)}`);
      }
      if (s.events.length !== 1 || s.events[0]!.name !== "evt") {
        throw new Error(`events mangled: ${JSON.stringify(s.events)}`);
      }
      if (s.links.length !== 1 || s.links[0]!.attributes?.rel !== "parent") {
        throw new Error(`links mangled: ${JSON.stringify(s.links)}`);
      }
    },
  },
  {
    name: "exporter accepts an empty batch without error",
    async run(exporter) {
      await exporter.export([]);
    },
    assert(spans) {
      assertSpanCount(spans, 0);
    },
  },
  {
    name: "exporter accepts a batch of many spans",
    async run(exporter) {
      const batch = Array.from({ length: 50 }, (_, i) =>
        makeSpan(`op-${i}`, "internal"),
      );
      await exporter.export(batch);
    },
    assert(spans) {
      assertSpanCount(spans, 50);
    },
  },
  {
    name: "exporter does not mutate a frozen span",
    async run(exporter) {
      const span = Object.freeze({
        ...makeSpan("frozen", "internal"),
        attributes: Object.freeze({ readonly: true }) as SpanAttributes,
      });
      await exporter.export([span]);
    },
    assert(spans) {
      assertSpanCount(spans, 1);
    },
  },
];

export interface RecordingSpanHandle {
  exporter: SpanExporter;
  spans: readonly ReadableSpan[];
}

export function recordingSpanHandle(): RecordingSpanHandle {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    exporter: {
      export(batch) {
        for (const s of batch) spans.push(s);
      },
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Assertion helpers
// ────────────────────────────────────────────────────────────────────

export function assertSpanCount(
  spans: readonly ReadableSpan[],
  expected: number,
): void {
  if (spans.length !== expected) {
    throw new Error(`expected ${expected} span(s), got ${spans.length}`);
  }
}

export function assertSpanKind(span: ReadableSpan, kind: SpanKind): void {
  if (span.kind !== kind) {
    throw new Error(`expected kind "${kind}", got "${span.kind}"`);
  }
}

export function assertSpanName(span: ReadableSpan, name: string): void {
  if (span.name !== name) {
    throw new Error(
      `expected name ${JSON.stringify(name)}, got ${JSON.stringify(span.name)}`,
    );
  }
}

export function assertSpanStatus(
  span: ReadableSpan,
  code: "unset" | "ok" | "error",
): void {
  if (span.status.code !== code) {
    throw new Error(
      `expected status "${code}", got "${span.status.code}"`,
    );
  }
}

export function assertParentChild(
  parent: ReadableSpan,
  child: ReadableSpan,
): void {
  if (child.traceId !== parent.traceId) {
    throw new Error(
      `expected child.traceId ${parent.traceId}, got ${child.traceId}`,
    );
  }
  if (child.parentSpanId !== parent.spanId) {
    throw new Error(
      `expected child.parentSpanId ${parent.spanId}, got ${child.parentSpanId}`,
    );
  }
}

/**
 * `createTracer` — factory for the trace subsystem.
 *
 * Reads the parent span from `forge/telemetry/context` so a span
 * started inside `withContext(...)` or a previous `withSpan(...)`
 * automatically inherits the trace id and becomes a child.
 *
 * @module
 */

import { genSpanId, genTraceId } from "../context/ids";
import { contextStorage, currentContext } from "../context/storage";
import { TRACE_FLAGS, type TelemetryContext } from "../context/types";
import { alwaysOnSampler } from "./samplers/always-on";
import type {
  CreateTracer,
  ReadableSpan,
  Sampler,
  Span,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanLink,
  SpanOptions,
  SpanProcessor,
  SpanStatus,
  Tracer,
  TracerOptions,
} from "./types";

interface ActiveSpanState {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  traceFlags: number;
  startTime: Date;
  attributes: SpanAttributes;
  events: SpanEvent[];
  links: SpanLink[];
  status: SpanStatus;
  ended: boolean;
  isRecording: boolean;
}

export const createTracer: CreateTracer = (options: TracerOptions): Tracer => {
  const sampler: Sampler = options.sampler ?? alwaysOnSampler();
  const processor: SpanProcessor = options.processor;
  const now = options.now ?? (() => new Date());
  const resource = options.resource;

  function buildSpan(state: ActiveSpanState): Span {
    const span: Span = {
      get traceId() {
        return state.traceId;
      },
      get spanId() {
        return state.spanId;
      },
      get isRecording() {
        return state.isRecording && !state.ended;
      },
      setAttribute(key, value) {
        if (state.ended || !state.isRecording) return span;
        state.attributes[key] = value;
        return span;
      },
      setAttributes(attrs) {
        if (state.ended || !state.isRecording) return span;
        for (const k of Object.keys(attrs)) {
          state.attributes[k] = attrs[k];
        }
        return span;
      },
      setStatus(status) {
        if (state.ended || !state.isRecording) return span;
        // Once `ok` is set, do not allow downgrade to `error` — match
        // OTel semantics.
        if (state.status.code === "ok" && status.code === "error") return span;
        state.status = status;
        return span;
      },
      addEvent(name, attributes) {
        if (state.ended || !state.isRecording) return span;
        const event: SpanEvent = attributes
          ? { name, timestamp: now(), attributes: { ...attributes } }
          : { name, timestamp: now() };
        state.events.push(event);
        return span;
      },
      addLink(link) {
        if (state.ended || !state.isRecording) return span;
        state.links.push(link);
        return span;
      },
      end(endTime) {
        if (state.ended) return;
        state.ended = true;
        if (!state.isRecording) return;
        const readable: ReadableSpan = {
          name: state.name,
          kind: state.kind,
          traceId: state.traceId,
          spanId: state.spanId,
          parentSpanId: state.parentSpanId,
          traceFlags: state.traceFlags,
          startTime: state.startTime,
          endTime: endTime ?? now(),
          status: state.status,
          attributes: { ...state.attributes },
          events: [...state.events],
          links: [...state.links],
          resource,
        };
        try {
          processor.onEnd(readable);
        } catch {
          // never let processor errors escape into the host app
        }
      },
    };
    return span;
  }

  function startSpan(name: string, opts?: SpanOptions): Span {
    const parent = opts?.root ? undefined : currentContext();
    const traceId = parent?.traceId ?? genTraceId();
    const spanId = genSpanId();
    const parentSpanId = parent?.spanId;
    const kind: SpanKind = opts?.kind ?? "internal";
    const attributes: SpanAttributes = { ...(opts?.attributes ?? {}) };
    const links: SpanLink[] = [...(opts?.links ?? [])];

    const decision = sampler.shouldSample(
      parent?.traceId,
      parent?.spanId,
      parent?.traceFlags,
      name,
      kind,
      attributes,
      links,
    );

    if (decision.attributes) {
      for (const k of Object.keys(decision.attributes)) {
        attributes[k] = decision.attributes[k];
      }
    }

    let traceFlags = parent?.traceFlags ?? 0;
    if (decision.decision === "record_and_sampled") {
      traceFlags |= TRACE_FLAGS.SAMPLED;
    } else if (decision.decision === "drop") {
      traceFlags &= ~TRACE_FLAGS.SAMPLED;
    }

    const isRecording = decision.decision !== "drop";

    const state: ActiveSpanState = {
      name,
      kind,
      traceId,
      spanId,
      parentSpanId,
      traceFlags,
      startTime: opts?.startTime ?? now(),
      attributes,
      events: [],
      links,
      status: { code: "unset" },
      ended: false,
      isRecording,
    };

    const span = buildSpan(state);
    try {
      processor.onStart(span);
    } catch {
      // ignore
    }
    return span;
  }

  function withSpan<T>(
    name: string,
    fn: (span: Span) => T,
    opts?: SpanOptions,
  ): T {
    const span = startSpan(name, opts);
    const parent = currentContext();
    const ctx: TelemetryContext = parent
      ? {
          ...parent,
          traceId: span.traceId,
          spanId: span.spanId,
          parentId: parent.spanId,
        }
      : {
          traceId: span.traceId,
          spanId: span.spanId,
          traceFlags: TRACE_FLAGS.SAMPLED,
          baggage: {},
        };
    return contextStorage.run(ctx, () => {
      try {
        const result = fn(span);
        if (isPromise(result)) {
          return result.then(
            (value) => {
              span.end();
              return value;
            },
            (err: unknown) => {
              span.setStatus({
                code: "error",
                message: err instanceof Error ? err.message : String(err),
              });
              span.end();
              throw err;
            },
          ) as unknown as T;
        }
        span.end();
        return result;
      } catch (err) {
        span.setStatus({
          code: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    });
  }

  return { startSpan, withSpan };
};

function isPromise<T>(value: T): value is T & Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Distributed tracing for `forge/telemetry`.
 *
 * @example
 * ```ts
 * import { createTracer, simpleSpanProcessor } from "forge/telemetry/trace";
 * import { stdoutSpanExporter } from "forge/telemetry/trace/exporters/stdout";
 *
 * const tracer = createTracer({
 *   resource: { serviceName: "api" },
 *   processor: simpleSpanProcessor({ exporter: stdoutSpanExporter() }),
 * });
 *
 * await tracer.withSpan("checkout", async (span) => {
 *   span.setAttribute("user.id", userId);
 *   await charge();
 *   span.setStatus({ code: "ok" });
 * });
 * ```
 *
 * @module
 */

export { createTracer } from "./tracer";
export { alwaysOffSampler } from "./samplers/always-off";
export { alwaysOnSampler } from "./samplers/always-on";
export {
  parentBasedSampler,
  type ParentBasedSamplerOptions,
} from "./samplers/parent-based";
export { ratioSampler, type RatioSamplerOptions } from "./samplers/ratio";
export {
  simpleSpanProcessor,
  type SimpleSpanProcessorOptions,
} from "./processors/simple";
export {
  batchSpanProcessor,
  type BatchSpanProcessorOptions,
} from "./processors/batch";
export type {
  CreateTracer,
  ReadableSpan,
  Sampler,
  SamplingDecision,
  SamplingResult,
  Span,
  SpanAttributes,
  SpanBatch,
  SpanEvent,
  SpanExporter,
  SpanKind,
  SpanLink,
  SpanOptions,
  SpanProcessor,
  SpanStatus,
  SpanStatusCode,
  Tracer,
  TracerOptions,
} from "./types";

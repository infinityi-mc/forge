/**
 * Test utilities for `forge/telemetry/trace` consumers and exporter
 * authors.
 *
 * Bring-your-own test runner: every helper here throws plain `Error`s
 * on failure, so they work under Bun's test runner, Vitest, Jest, or
 * any other framework.
 *
 * @module
 */

export { recordingSpanExporter } from "../exporters/recording";
export type {
  RecordingSpanExporter,
  RecordingSpanExporterOptions,
} from "../exporters/recording";
export {
  STANDARD_SPAN_SCENARIOS,
  assertParentChild,
  assertSpanCount,
  assertSpanKind,
  assertSpanName,
  assertSpanStatus,
  recordingSpanHandle,
} from "./conformance";
export type {
  RecordingSpanHandle,
  SpanConformanceScenario,
} from "./conformance";

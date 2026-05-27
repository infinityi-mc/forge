/**
 * Test utilities for `forge/telemetry/meter` consumers and exporter
 * authors.
 *
 * Bring-your-own test runner: every helper here throws plain `Error`s
 * on failure, so they work under Bun's test runner, Vitest, Jest, or
 * any other framework.
 *
 * @module
 */

export { recordingMeterExporter } from "../exporters/recording";
export type {
  RecordingMeterExporter,
  RecordingMeterExporterOptions,
} from "../exporters/recording";
export {
  STANDARD_METER_SCENARIOS,
  assertBatchCount,
  assertHistogramInvariant,
  assertPointCount,
  recordingMeterHandle,
} from "./conformance";
export type {
  MeterConformanceScenario,
  RecordingMeterHandle,
} from "./conformance";

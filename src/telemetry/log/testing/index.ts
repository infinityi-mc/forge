/**
 * Test utilities for `forge/telemetry/log` consumers and exporter
 * authors.
 *
 * Bring-your-own test runner: every helper here throws plain `Error`s
 * on failure, so they work under Bun's test runner, Vitest, Jest, or
 * any other framework.
 *
 * @module
 */

export {
  STANDARD_LOG_SCENARIOS,
  assertNoRecordsAtLevel,
  assertRecordAttributes,
  assertRecordCount,
  assertRecordLevel,
  assertRecordMessage,
  assertValidLogRecord,
  recordingTransport,
} from "./conformance";
export type {
  LogConformanceScenario,
  RecordingExporterHandle,
} from "./conformance";
export { recordingExporter } from "../exporters/recording";
export type {
  RecordingExporter,
  RecordingExporterOptions,
} from "../exporters/recording";

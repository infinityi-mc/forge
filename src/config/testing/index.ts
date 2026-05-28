/**
 * Test utilities for `forge/config`.
 *
 * @module
 */

export { mockConfig } from "./mock";
export type { DeepPartial } from "./mock";

export { recordingProvider } from "./recording-provider";
export type {
  RecordingProvider,
  RecordingProviderOptions,
} from "./recording-provider";

export {
  STANDARD_CONFIG_PROVIDER_SCENARIOS,
  assertProviderConformance,
  controllableProvider,
} from "./conformance";
export type {
  ConfigProviderConformanceHarness,
  ConfigProviderConformanceScenario,
  ConfigProviderFactory,
} from "./conformance";

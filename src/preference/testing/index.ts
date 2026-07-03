/**
 * Test utilities for `forge/preference`.
 *
 * @module
 */

export {
  STANDARD_PREFERENCE_STORE_SCENARIOS,
  assertPreferenceStoreConformance,
} from "./conformance";
export { memoryStore } from "../memory-store";
export { mockPreferences } from "./mock";
export type {
  PreferenceStoreConformanceHarness,
  PreferenceStoreConformanceScenario,
  PreferenceStoreFactory,
} from "./conformance";
export type { MemoryPreferenceStore, MemoryStoreOptions } from "../memory-store";
export type { DeepPartial } from "./mock";

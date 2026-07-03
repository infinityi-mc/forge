/**
 * `forge/preference` — user-owned, runtime-mutable, fail-safe settings.
 *
 * PR A exposes the read path: schema reuse, fail-safe per-leaf validation,
 * memory store, diagnostics, and a deeply-frozen live values proxy.
 *
 * @module
 */

export { definePreferences } from "./define";
export { memoryStore } from "./memory-store";
export { t } from "../config/schema/builder";

export {
  PreferenceError,
  PreferenceSchemaError,
  PreferenceStoreError,
  PreferenceValidationError,
} from "./errors";

export type {
  DefinePreferencesOptions,
  PreferenceChangeHandler,
  PreferenceDiagnostic,
  PreferenceDiagnosticStatus,
  PreferenceLeaf,
  PreferencePath,
  PreferencePathValue,
  PreferenceSchema,
  PreferenceSchemaNode,
  PreferenceSnapshot,
  PreferenceSnapshotHandler,
  PreferenceStore,
  PreferenceUpdate,
  PreferenceWritableValue,
  PreferencesHandle,
  PreferenceValues,
} from "./types";

export type { MemoryPreferenceStore, MemoryStoreOptions } from "./memory-store";

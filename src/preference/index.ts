/**
 * `forge/preference` — user-owned, runtime-mutable, fail-safe settings.
 *
 * Exposes fail-safe preference reads, validated writes, durable stores,
 * versioning, scopes, observability, and lifecycle helpers.
 *
 * @module
 */

export { definePreferences } from "./define";
export { jsonFileStore } from "./json-file-store";
export { memoryStore } from "./memory-store";
export { sqliteStore } from "./sqlite-store";
export { t } from "../config/schema/builder";

export {
  PreferenceError,
  PreferenceSchemaError,
  PreferenceStoreError,
  PreferenceValidationError,
} from "./errors";

export type {
  JsonFilePreferenceStore,
  JsonFileStoreOptions,
} from "./json-file-store";
export type { Logger, LogAttributes } from "../config/logger";
export type { MemoryPreferenceStore, MemoryStoreOptions } from "./memory-store";
export type { SqlitePreferenceStore, SqliteStoreOptions } from "./sqlite-store";

export type {
  DefinePreferencesOptions,
  DefinePreferencesBaseOptions,
  DefinePreferencesScopedOptions,
  DefinePreferencesStoreOptions,
  PreferenceChangeHandler,
  PreferenceDiagnostic,
  PreferenceDiagnosticStatus,
  PreferenceLeaf,
  PreferenceMigration,
  PreferencePath,
  PreferencePathValue,
  PreferenceSchema,
  PreferenceSchemaNode,
  PreferenceScopeName,
  PreferenceScopeOptions,
  PreferenceScopeStores,
  PreferenceSnapshot,
  PreferenceSnapshotHandler,
  PreferenceStore,
  PreferenceUpdate,
  PreferenceWritableValue,
  PreferencesHandle,
  PreferenceValues,
} from "./types";

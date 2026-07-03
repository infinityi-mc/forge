/**
 * Structured observability for `forge/preference`.
 *
 * Preference logs are intentionally structural: paths, store names, scopes,
 * and versions only. User preference values are never attached to log attrs.
 *
 * @module
 */

import type { Logger } from "../config/logger";

const MODULE_TAG = "forge/preference";

export interface PreferenceScopeLogEntry {
  readonly scope?: string;
  readonly store: string;
}

export interface PreferenceLoadSummary {
  readonly loadTimeMs: number;
  readonly stores: readonly string[];
  readonly scopes: readonly PreferenceScopeLogEntry[];
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
}

export interface PreferenceSaveSummary {
  readonly store: string;
  readonly scope?: string;
  readonly savedKeys: readonly string[];
  readonly version?: number;
}

export interface PreferenceExternalReloadSummary {
  readonly store: string;
  readonly scope?: string;
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
  readonly changedKeys: readonly string[];
  readonly version?: number;
}

export interface PreferenceMigrationSummary {
  readonly store: string;
  readonly scope?: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrationVersions: readonly number[];
}

export function emitPreferenceLoadSummary(
  logger: Logger,
  summary: PreferenceLoadSummary,
): void {
  safeLog(logger, "info", "Preferences loaded", {
    module: MODULE_TAG,
    load_time_ms: summary.loadTimeMs,
    stores: summary.stores,
    scopes: summary.scopes,
    loaded_keys: summary.loadedKeys,
    fallback_keys: summary.fallbackKeys,
  });
}

export function emitPreferenceSave(
  logger: Logger,
  summary: PreferenceSaveSummary,
): void {
  safeLog(logger, "info", "Preferences saved", {
    module: MODULE_TAG,
    store: summary.store,
    ...(summary.scope === undefined ? {} : { scope: summary.scope }),
    saved_keys: summary.savedKeys,
    ...(summary.version === undefined ? {} : { version: summary.version }),
  });
}

export function emitPreferenceExternalReload(
  logger: Logger,
  summary: PreferenceExternalReloadSummary,
): void {
  const level = summary.changedKeys.length === 0 ? "info" : "warn";
  safeLog(logger, level, "Preferences externally reloaded", {
    module: MODULE_TAG,
    store: summary.store,
    ...(summary.scope === undefined ? {} : { scope: summary.scope }),
    loaded_keys: summary.loadedKeys,
    fallback_keys: summary.fallbackKeys,
    changed_keys: summary.changedKeys,
    ...(summary.version === undefined ? {} : { version: summary.version }),
  });
}

export function emitPreferenceMigration(
  logger: Logger,
  summary: PreferenceMigrationSummary,
): void {
  safeLog(logger, "info", "Preferences migrated", {
    module: MODULE_TAG,
    store: summary.store,
    ...(summary.scope === undefined ? {} : { scope: summary.scope }),
    from_version: summary.fromVersion,
    to_version: summary.toVersion,
    migration_versions: summary.migrationVersions,
  });
}

function safeLog(
  logger: Logger,
  level: "info" | "warn" | "error",
  msg: string,
  attrs: Readonly<Record<string, unknown>>,
): void {
  try {
    logger[level](msg, attrs);
  } catch {
    // Observability must never change preference load/write behavior.
  }
}

/**
 * `definePreferences` — fail-safe preference read path.
 *
 * PR A loads explicit user values from a store, validates each schema leaf
 * independently, falls back safely, and exposes a deeply-frozen live-view proxy.
 * Write APIs, subscriptions, lifecycle, migrations, and scopes land in later PRs.
 *
 * @module
 */

import { createSnapshotProxy, type SnapshotRef } from "../config/dynamic/proxy";
import { deepFreeze } from "../config/schema/walk";
import type {
  DefinePreferencesOptions,
  PreferenceDiagnostic,
  PreferenceSchema,
  PreferenceSnapshot,
  PreferencesHandle,
  PreferenceValues,
} from "./types";
import {
  assertPreferenceSchema,
  validatePreferenceSnapshot,
} from "./validate";

export async function definePreferences<S extends PreferenceSchema>(
  schema: S,
  options: DefinePreferencesOptions,
): Promise<PreferencesHandle<S>> {
  assertPreferenceSchema(schema);

  const diagnostics: PreferenceDiagnostic[] = [];
  let explicit: PreferenceSnapshot | undefined;

  try {
    explicit = await options.store.load();
  } catch (err) {
    diagnostics.push({
      status: "store_error",
      store: options.store.name,
      reason: storeErrorReason(options.store.name, err),
    });
  }

  const result = validatePreferenceSnapshot(schema, explicit ?? {});
  diagnostics.push(...result.diagnostics);

  await emitDiagnostics(diagnostics, options.onDiagnostic);

  const ref: SnapshotRef<PreferenceValues<S>> = {
    current: deepFreeze(result.tree),
  };

  return {
    values: createSnapshotProxy(ref as SnapshotRef<object>, {
      namespace: "forge/preference",
      mutationHint: "preference values are read-only.",
    }) as PreferenceValues<S>,
    diagnostics,
  };
}

async function emitDiagnostics(
  diagnostics: readonly PreferenceDiagnostic[],
  handler: DefinePreferencesOptions["onDiagnostic"],
): Promise<void> {
  if (handler === undefined) return;
  for (const diagnostic of diagnostics) {
    try {
      await handler(diagnostic);
    } catch {
      // Diagnostics must not turn fail-safe preference reads into failures.
    }
  }
}

function storeErrorReason(store: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Preference store '${store}' failed to load; using defaults. ${message}`;
}

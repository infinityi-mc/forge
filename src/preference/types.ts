/**
 * Public types for `forge/preference`.
 *
 * @module
 */

import type {
  DefaultedLeaf,
  Leaf,
  OptionalLeaf,
} from "../config/schema/types";

/** A leaf that can always fall back safely on the preference read path. */
export type PreferenceLeaf = DefaultedLeaf<unknown> | OptionalLeaf<unknown>;

export type PreferenceSchemaNode = PreferenceLeaf | PreferenceSchema;

/**
 * Preference schemas reuse `forge/config` leaves, but every leaf must declare
 * either `.default(...)` or `.optional()` so corrupt user data never leaves the
 * loader without a safe value.
 */
export interface PreferenceSchema {
  readonly [key: string]: PreferenceSchemaNode;
}

/** Infer the deeply-readonly runtime values exposed at `prefs.values`. */
export type PreferenceValues<S> = S extends Leaf<infer T>
  ? T
  : S extends PreferenceSchema
    ? { readonly [K in keyof S]: PreferenceValues<S[K]> }
    : never;

/** Snapshot keyed by dotted schema path, containing explicit user values only. */
export type PreferenceSnapshot = Readonly<Record<string, unknown>>;

/** Callback fired by stores that can observe external preference changes. */
export type PreferenceSnapshotHandler = (snapshot: PreferenceSnapshot) => void;

/** Minimal store seam for user-owned preference persistence. */
export interface PreferenceStore {
  readonly name: string;
  load(): Promise<PreferenceSnapshot | undefined>;
  save(snapshot: PreferenceSnapshot): Promise<void>;
  watch?(onExternalChange: PreferenceSnapshotHandler): () => void;
  shutdown?(): Promise<void>;
}

export type PreferenceDiagnosticStatus = "invalid" | "store_error";

/** Non-fatal diagnostic emitted when preferences fall back safely. */
export interface PreferenceDiagnostic {
  readonly status: PreferenceDiagnosticStatus;
  readonly reason: string;
  readonly path?: string;
  readonly store?: string;
  readonly received?: unknown;
}

export interface DefinePreferencesOptions {
  readonly store: PreferenceStore;
  readonly onDiagnostic?: (
    diagnostic: PreferenceDiagnostic,
  ) => void | Promise<void>;
}

export interface PreferencesHandle<S extends PreferenceSchema> {
  /** Live proxy view of the latest validated and deeply-frozen preference tree. */
  readonly values: PreferenceValues<S>;
  /** Diagnostics produced while loading the current snapshot. */
  readonly diagnostics: readonly PreferenceDiagnostic[];
}

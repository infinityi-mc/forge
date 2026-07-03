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
import type { Logger } from "../config/logger";

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

type StringKeyOf<T> = Extract<keyof T, string>;

/** Dotted path union for every leaf in a preference schema. */
export type PreferencePath<S> = S extends PreferenceLeaf
  ? never
  : S extends PreferenceSchema
    ? {
        [K in StringKeyOf<S>]: S[K] extends PreferenceLeaf
          ? K
          : S[K] extends PreferenceSchema
            ? `${K}.${PreferencePath<S[K]>}`
            : never;
      }[StringKeyOf<S>]
    : never;

/** Runtime value type exposed at a dotted preference path. */
export type PreferencePathValue<
  S,
  P extends string,
> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof S
    ? PreferencePathValue<S[Head], Rest>
    : never
  : P extends keyof S
    ? PreferenceValues<S[P]>
    : never;

/** Values accepted by write APIs. Use `reset(path)` to clear optionals. */
export type PreferenceWritableValue<
  S,
  P extends PreferencePath<S>,
> = Exclude<PreferencePathValue<S, P>, undefined>;

type PreferenceUpdateObject<S> = {
  [K in StringKeyOf<S>]: {
    readonly [P in K]: PreferenceUpdate<S[P]>;
  } & PreferenceUpdateTail<Omit<S, K>>;
}[StringKeyOf<S>];

type PreferenceUpdateTail<S> = StringKeyOf<S> extends never
  ? {}
  : {} | PreferenceUpdateObject<S>;

/** Nested partial patch accepted by `prefs.update(...)`. */
export type PreferenceUpdate<S> = S extends PreferenceLeaf
  ? Exclude<PreferenceValues<S>, undefined>
  : S extends PreferenceSchema
    ? PreferenceUpdateObject<S>
    : never;

/** Snapshot keyed by dotted schema path, containing explicit user values only. */
export type PreferenceSnapshot = Readonly<Record<string, unknown>>;

/** Migration hook for raw persisted snapshots, keyed by target version. */
export type PreferenceMigration = (
  snapshot: PreferenceSnapshot,
) => PreferenceSnapshot | Promise<PreferenceSnapshot>;

/** Ordered scope map. Object insertion order defines precedence; later wins. */
export type PreferenceScopeStores = Readonly<Record<string, PreferenceStore>>;

export type PreferenceScopeName<Scopes extends PreferenceScopeStores> = Extract<
  keyof Scopes,
  string
>;

/** Callback fired by stores that can observe external preference changes. */
export type PreferenceSnapshotHandler = (snapshot: PreferenceSnapshot) => void;

/** Minimal store seam for user-owned preference persistence. */
export interface PreferenceStore {
  readonly name: string;
  load(): Promise<PreferenceSnapshot | undefined>;
  save(snapshot: PreferenceSnapshot): Promise<void>;
  watch?(onExternalChange: PreferenceSnapshotHandler): () => void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export type PreferenceDiagnosticStatus =
  | "invalid"
  | "migration_error"
  | "store_error";

/** Non-fatal diagnostic emitted when preferences fall back safely. */
export interface PreferenceDiagnostic {
  readonly status: PreferenceDiagnosticStatus;
  readonly reason: string;
  readonly path?: string;
  readonly scope?: string;
  readonly store?: string;
  readonly version?: number;
  readonly received?: unknown;
}

export interface DefinePreferencesBaseOptions {
  /** Current application preference schema version. Enables persisted `$version`. */
  readonly version?: number;
  /** Ordered migrations keyed by target version. */
  readonly migrations?: Readonly<Record<number, PreferenceMigration>>;
  /** Optional structured logger. Emits structural paths/metadata, never values. */
  readonly logger?: Logger;
  readonly onDiagnostic?: (
    diagnostic: PreferenceDiagnostic,
  ) => void | Promise<void>;
}

export interface DefinePreferencesStoreOptions
  extends DefinePreferencesBaseOptions {
  readonly store: PreferenceStore;
  readonly scopes?: never;
}

export interface DefinePreferencesScopedOptions<
  Scopes extends PreferenceScopeStores = PreferenceScopeStores,
> extends DefinePreferencesBaseOptions {
  readonly scopes: Scopes;
  readonly store?: never;
}

export type DefinePreferencesOptions<
  Scopes extends PreferenceScopeStores = PreferenceScopeStores,
> = DefinePreferencesStoreOptions | DefinePreferencesScopedOptions<Scopes>;

export interface PreferenceScopeOptions<Scope extends string = never> {
  readonly scope?: Scope;
}

export type PreferenceChangeHandler<S extends PreferenceSchema> = (
  oldValues: PreferenceValues<S>,
  nextValues: PreferenceValues<S>,
  changedKeys: readonly PreferencePath<S>[],
) => void;

export interface PreferencesHandle<
  S extends PreferenceSchema,
  Scope extends string = never,
> {
  /** Live proxy view of the latest validated and deeply-frozen preference tree. */
  readonly values: PreferenceValues<S>;
  /** Diagnostics produced while loading the current snapshot. */
  readonly diagnostics: readonly PreferenceDiagnostic[];
  /** Persist an explicit value for one preference leaf. */
  set<P extends PreferencePath<S>>(
    path: P,
    value: PreferenceWritableValue<S, P>,
    options?: PreferenceScopeOptions<Scope>,
  ): Promise<void>;
  /** Atomically apply a nested partial patch derived from the current values. */
  update(
    updater: (
      values: PreferenceValues<S>,
    ) => PreferenceUpdate<S> | void | Promise<PreferenceUpdate<S> | void>,
  ): Promise<void>;
  /** Delete an explicit value so the default or optional fallback shows through. */
  reset<P extends PreferencePath<S>>(
    path: P,
    options?: PreferenceScopeOptions<Scope>,
  ): Promise<void>;
  /** Delete every explicit value. */
  resetAll(options?: PreferenceScopeOptions<Scope>): Promise<void>;
  /** Whether a path has an explicit persisted value. */
  isSet<P extends PreferencePath<S>>(
    path: P,
    options?: PreferenceScopeOptions<Scope>,
  ): boolean;
  /** Subscribe to effective value changes. */
  subscribe(handler: PreferenceChangeHandler<S>): () => void;
  /** Drain pending store work when the store supports it. */
  flush(): Promise<void>;
  /** Flush and release store resources. Safe to call more than once. */
  shutdown(): Promise<void>;
  /** TS 5.2+ disposable hook; aliases `shutdown()`. */
  [Symbol.asyncDispose](): Promise<void>;
}

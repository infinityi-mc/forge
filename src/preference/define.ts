/**
 * `definePreferences` — fail-safe preference read path plus validated writes.
 *
 * Preferences keep two separate shapes:
 * - the persisted explicit snapshot, keyed by dotted leaf paths;
 * - the merged, typed, deeply-frozen live view exposed through `values`.
 *
 * Writes validate caller input, persist the explicit snapshot, then atomically
 * swap the live view. User-owned store data is still fail-safe on reads and
 * external reloads: invalid leaves fall back independently with diagnostics.
 *
 * @module
 */

import { diff } from "../config/dynamic/diff";
import type { SnapshotRef } from "../config/dynamic/proxy";
import { isLeaf, type Leaf } from "../config/schema/types";
import { collectLeaves, deepFreeze } from "../config/schema/walk";
import type { ConfigSchema } from "../config/types";
import {
  PreferenceSchemaError,
  PreferenceStoreError,
  PreferenceValidationError,
} from "./errors";
import { createMockablePreferenceValues } from "./mockable";
import {
  emitPreferenceExternalReload,
  emitPreferenceLoadSummary,
  emitPreferenceMigration,
  emitPreferenceSave,
} from "./observability";
import { cloneStoreSnapshot, setSnapshotValue } from "./store-snapshot";
import type {
  DefinePreferencesBaseOptions,
  DefinePreferencesOptions,
  DefinePreferencesScopedOptions,
  DefinePreferencesStoreOptions,
  PreferenceChangeHandler,
  PreferenceDiagnostic,
  PreferenceMigration,
  PreferencePath,
  PreferenceSchema,
  PreferenceSchemaNode,
  PreferenceScopeName,
  PreferenceScopeOptions,
  PreferenceScopeStores,
  PreferenceSnapshot,
  PreferenceStore,
  PreferencesHandle,
  PreferenceUpdate,
  PreferenceValues,
  PreferenceWritableValue,
} from "./types";
import {
  assertPreferenceSchema,
  validatePreferenceSnapshot,
  validatePreferenceWriteValue,
} from "./validate";

const VERSION_KEY = "$version";

interface PatchEntry {
  readonly path: string;
  readonly leaf: Leaf<unknown>;
  readonly value: unknown;
}

interface VersioningOptions {
  readonly currentVersion?: number;
  readonly migrations: ReadonlyMap<number, PreferenceMigration>;
}

interface ScopeDefinition {
  readonly name: string;
  readonly diagnosticScope?: string;
  readonly store: PreferenceStore;
}

interface ScopeState extends ScopeDefinition {
  explicit: PreferenceSnapshot;
  preserved: PreferenceSnapshot;
  version: number | undefined;
  unsubscribeExternal?: () => void;
  unsubscribedFromExternal: boolean;
}

interface PreparedScopeSnapshot {
  readonly explicit: PreferenceSnapshot;
  readonly preserved: PreferenceSnapshot;
  readonly version: number | undefined;
  readonly diagnostics: readonly PreferenceDiagnostic[];
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
  readonly migration?: AppliedMigration;
}

interface SplitSnapshot {
  readonly known: PreferenceSnapshot;
  readonly unknown: PreferenceSnapshot;
}

interface AppliedMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly versions: readonly number[];
}

interface MigrationResult {
  readonly snapshot: PreferenceSnapshot;
  readonly version: number | undefined;
  readonly fromVersion?: number;
  readonly appliedVersions: readonly number[];
}

interface MergedScopeApplyResult<S extends PreferenceSchema> {
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
  readonly changedKeys: readonly PreferencePath<S>[];
}

export async function definePreferences<S extends PreferenceSchema>(
  schema: S,
  options: DefinePreferencesStoreOptions,
): Promise<PreferencesHandle<S>>;
export async function definePreferences<
  S extends PreferenceSchema,
  Scopes extends PreferenceScopeStores,
>(
  schema: S,
  options: DefinePreferencesScopedOptions<Scopes>,
): Promise<PreferencesHandle<S, PreferenceScopeName<Scopes>>>;
export async function definePreferences<
  S extends PreferenceSchema,
  Scopes extends PreferenceScopeStores,
>(
  schema: S,
  options: DefinePreferencesOptions<Scopes>,
): Promise<PreferencesHandle<S, PreferenceScopeName<Scopes>>> {
  const startedAt = performance.now();
  assertPreferenceSchema(schema);

  const diagnostics: PreferenceDiagnostic[] = [];
  const loadFallbackKeys: string[] = [];
  const leafEntries = collectLeaves(schema as unknown as ConfigSchema);
  const leafPaths = leafEntries.map((entry) => entry.path);
  assertNoReservedPreferencePath(leafPaths);

  const leafPathSet = new Set(leafPaths);
  const leafMap = new Map(
    leafEntries.map((entry) => [entry.path, entry.leaf]),
  );
  const versioning = normalizeVersioning(options);
  const scopeStates = normalizeScopes(options).map(
    (definition): ScopeState => ({
      ...definition,
      explicit: {},
      preserved: {},
      version: versioning.currentVersion,
      unsubscribedFromExternal: false,
    }),
  );
  const scopeMap = new Map(
    scopeStates
      .filter((scope) => scope.diagnosticScope !== undefined)
      .map((scope) => [scope.diagnosticScope!, scope]),
  );
  const defaultWriteScope = scopeStates.at(-1)!;
  const logger = options.logger;

  for (const scope of scopeStates) {
    let loaded: PreferenceSnapshot | undefined;
    try {
      loaded = await scope.store.load();
    } catch (err) {
      diagnostics.push(
        scopeDiagnostic(scope, {
          status: "store_error",
          store: scope.store.name,
          reason: storeErrorReason(scope, "load", err),
        }),
      );
      continue;
    }

    if (loaded === undefined) continue;
    const prepared = await prepareScopeSnapshot(
      schema,
      leafPathSet,
      scope,
      loaded,
      versioning,
    );
    scope.explicit = cloneSnapshot(prepared.explicit);
    scope.preserved = cloneSnapshot(prepared.preserved);
    scope.version = prepared.version;
    diagnostics.push(...prepared.diagnostics);
    loadFallbackKeys.push(...prepared.fallbackKeys);
    if (logger !== undefined && prepared.migration !== undefined) {
      emitPreferenceMigration(logger, {
        store: scope.store.name,
        ...(scope.diagnosticScope === undefined
          ? {}
          : { scope: scope.diagnosticScope }),
        fromVersion: prepared.migration.fromVersion,
        toVersion: prepared.migration.toVersion,
        migrationVersions: prepared.migration.versions,
      });
    }
  }

  const initial = validatePreferenceSnapshot(
    schema,
    mergeScopeExplicitSnapshots(scopeStates),
  );
  diagnostics.push(...initial.diagnostics);

  await emitDiagnostics(diagnostics, options.onDiagnostic);

  if (logger !== undefined) {
    emitPreferenceLoadSummary(logger, {
      loadTimeMs: Math.round(performance.now() - startedAt),
      stores: scopeStates.map((scope) => scope.store.name),
      scopes: scopeStates.map((scope) => ({
        store: scope.store.name,
        ...(scope.diagnosticScope === undefined
          ? {}
          : { scope: scope.diagnosticScope }),
      })),
      loadedKeys: initial.loadedKeys,
      fallbackKeys: uniqueSorted([...initial.fallbackKeys, ...loadFallbackKeys]),
    });
  }

  let currentEffectiveExplicit = cloneSnapshot(initial.explicit);
  const ref: SnapshotRef<PreferenceValues<S>> = {
    current: deepFreeze(initial.tree),
  };
  const subscribers = new Set<PreferenceChangeHandler<S>>();
  let shutDown = false;
  let writeQueue: Promise<void> = Promise.resolve();

  const values = createMockablePreferenceValues(schema, ref, {
    namespace: "forge/preference",
    mutationHint: "preference values are read-only; use set/update/reset.",
  });

  const addDiagnostics = (nextDiagnostics: readonly PreferenceDiagnostic[]) => {
    if (nextDiagnostics.length === 0) return;
    diagnostics.push(...nextDiagnostics);
    void emitDiagnostics(nextDiagnostics, options.onDiagnostic);
  };

  const applyMergedScopes = (
    fallbackKeys: readonly string[] = [],
  ): MergedScopeApplyResult<S> => {
    const result = validatePreferenceSnapshot(
      schema,
      mergeScopeExplicitSnapshots(scopeStates),
    );
    addDiagnostics(result.diagnostics);
    currentEffectiveExplicit = cloneSnapshot(result.explicit);

    const previous = ref.current;
    const nextValues = deepFreeze(result.tree);
    const changedKeys = changedPreferenceKeys(
      leafPaths,
      previous,
      nextValues,
    ) as PreferencePath<S>[];
    const mergedFallbackKeys = uniqueSorted([
      ...result.fallbackKeys,
      ...fallbackKeys,
    ]);
    if (changedKeys.length === 0) {
      return {
        loadedKeys: result.loadedKeys,
        fallbackKeys: mergedFallbackKeys,
        changedKeys,
      };
    }

    ref.current = nextValues;
    notifySubscribers(subscribers, previous, ref.current, changedKeys);
    return {
      loadedKeys: result.loadedKeys,
      fallbackKeys: mergedFallbackKeys,
      changedKeys,
    };
  };

  const enqueueStateChange = (
    work: () => void | Promise<void>,
  ): Promise<void> => {
    const run = writeQueue.then(work);
    writeQueue = run.catch(() => {});
    return run;
  };

  const applyExternalSnapshot = (
    scope: ScopeState,
    snapshot: PreferenceSnapshot,
  ): void => {
    void enqueueStateChange(async () => {
      if (shutDown) return;
      const prepared = await prepareScopeSnapshot(
        schema,
        leafPathSet,
        scope,
        snapshot,
        versioning,
      );
      scope.explicit = cloneSnapshot(prepared.explicit);
      scope.preserved = cloneSnapshot(prepared.preserved);
      scope.version = prepared.version;
      addDiagnostics(prepared.diagnostics);
      const applied = applyMergedScopes(prepared.fallbackKeys);
      if (logger !== undefined && prepared.migration !== undefined) {
        emitPreferenceMigration(logger, {
          store: scope.store.name,
          ...(scope.diagnosticScope === undefined
            ? {}
            : { scope: scope.diagnosticScope }),
          fromVersion: prepared.migration.fromVersion,
          toVersion: prepared.migration.toVersion,
          migrationVersions: prepared.migration.versions,
        });
      }
      if (logger !== undefined) {
        emitPreferenceExternalReload(logger, {
          store: scope.store.name,
          ...(scope.diagnosticScope === undefined
            ? {}
            : { scope: scope.diagnosticScope }),
          loadedKeys: applied.loadedKeys,
          fallbackKeys: applied.fallbackKeys,
          changedKeys: applied.changedKeys,
          ...(scope.version === undefined ? {} : { version: scope.version }),
        });
      }
    });
  };

  for (const scope of scopeStates) {
    if (scope.store.watch === undefined) continue;
    try {
      scope.unsubscribeExternal = scope.store.watch((snapshot) => {
        applyExternalSnapshot(scope, snapshot);
      });
    } catch (err) {
      addDiagnostics([
        scopeDiagnostic(scope, {
          status: "store_error",
          store: scope.store.name,
          reason: storeErrorReason(scope, "watch", err),
        }),
      ]);
    }
  }

  const requireLeaf = (path: string): Leaf<unknown> => {
    const leaf = leafMap.get(path);
    if (leaf !== undefined) return leaf;
    throw validationError(path, "Unknown preference path.");
  };

  const resolveTargetScope = (
    scopeOptions?: PreferenceScopeOptions<PreferenceScopeName<Scopes>>,
  ): ScopeState => {
    const requested = scopeOptions?.scope;
    if (requested === undefined) return defaultWriteScope;
    const scope = scopeMap.get(requested);
    if (scope !== undefined) return scope;
    throw scopeValidationError(String(requested));
  };

  const commitScopeExplicit = async (
    scope: ScopeState,
    nextExplicit: PreferenceSnapshot,
  ): Promise<void> => {
    const result = validatePreferenceSnapshot(schema, nextExplicit);
    if (result.diagnostics.length > 0) {
      throw new PreferenceValidationError(
        `Invalid preference update (${result.diagnostics.length} issue(s)).`,
        { diagnostics: result.diagnostics },
      );
    }

    try {
      await scope.store.save(buildPersistedScopeSnapshot(scope, result.explicit));
    } catch (err) {
      throw new PreferenceStoreError(storeErrorReason(scope, "save", err), {
        cause: err,
        store: scope.store.name,
      });
    }

    if (logger !== undefined) {
      emitPreferenceSave(logger, {
        store: scope.store.name,
        ...(scope.diagnosticScope === undefined
          ? {}
          : { scope: scope.diagnosticScope }),
        savedKeys: Object.keys(result.explicit).sort(),
        ...(scope.version === undefined ? {} : { version: scope.version }),
      });
    }

    scope.explicit = cloneSnapshot(result.explicit);
    applyMergedScopes();
  };

  const assertOpen = (): void => {
    if (!shutDown) return;
    throw new PreferenceStoreError("Preferences have been shut down.", {
      store: defaultWriteScope.store.name,
    });
  };

  const set = async <P extends PreferencePath<S>>(
    path: P,
    value: PreferenceWritableValue<S, P>,
    scopeOptions?: PreferenceScopeOptions<PreferenceScopeName<Scopes>>,
  ): Promise<void> => {
    assertOpen();
    const target = resolveTargetScope(scopeOptions);
    const leaf = requireLeaf(path);
    const validated = validatePreferenceWriteValue(path, leaf, value);
    if (!validated.ok) {
      throw new PreferenceValidationError(
        `Invalid preference value for '${path}'.`,
        { diagnostics: [validated.diagnostic] },
      );
    }

    await enqueueStateChange(async () => {
      const nextExplicit = snapshotWithValue(
        target.explicit,
        path,
        validated.snapshotValue,
      );
      await commitScopeExplicit(target, nextExplicit);
    });
  };

  const update = async (
    updater: (
      values: PreferenceValues<S>,
    ) => PreferenceUpdate<S> | void | Promise<PreferenceUpdate<S> | void>,
  ): Promise<void> => {
    assertOpen();
    const target = defaultWriteScope;
    await enqueueStateChange(async () => {
      const patch = await updater(ref.current);
      if (patch === undefined) return;

      const entries: PatchEntry[] = [];
      flattenPreferencePatch(schema, patch, "", entries);
      if (entries.length === 0) return;

      let nextExplicit = cloneSnapshot(target.explicit);
      for (const entry of entries) {
        const result = validatePreferenceWriteValue(
          entry.path,
          entry.leaf,
          entry.value,
        );
        if (!result.ok) {
          throw new PreferenceValidationError(
            `Invalid preference value for '${entry.path}'.`,
            { diagnostics: [result.diagnostic] },
          );
        }
        nextExplicit = snapshotWithValue(
          nextExplicit,
          entry.path,
          result.snapshotValue,
        );
      }
      await commitScopeExplicit(target, nextExplicit);
    });
  };

  const reset = async <P extends PreferencePath<S>>(
    path: P,
    scopeOptions?: PreferenceScopeOptions<PreferenceScopeName<Scopes>>,
  ): Promise<void> => {
    assertOpen();
    const target = resolveTargetScope(scopeOptions);
    requireLeaf(path);
    await enqueueStateChange(async () => {
      if (!hasOwn(target.explicit, path)) return;
      await commitScopeExplicit(target, snapshotWithoutKey(target.explicit, path));
    });
  };

  const resetAll = async (
    scopeOptions?: PreferenceScopeOptions<PreferenceScopeName<Scopes>>,
  ): Promise<void> => {
    assertOpen();
    const target = resolveTargetScope(scopeOptions);
    await enqueueStateChange(async () => {
      await commitScopeExplicit(target, {});
    });
  };

  const isSet = <P extends PreferencePath<S>>(
    path: P,
    scopeOptions?: PreferenceScopeOptions<PreferenceScopeName<Scopes>>,
  ): boolean => {
    requireLeaf(path);
    if (scopeOptions?.scope !== undefined) {
      return hasOwn(resolveTargetScope(scopeOptions).explicit, path);
    }
    return hasOwn(currentEffectiveExplicit, path);
  };

  const subscribe = (handler: PreferenceChangeHandler<S>): (() => void) => {
    if (shutDown) return () => {};
    subscribers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(handler);
    };
  };

  const flush = async (): Promise<void> => {
    await writeQueue;
    let firstError: unknown;
    for (const scope of scopeStates) {
      if (scope.store.flush === undefined) continue;
      try {
        await scope.store.flush();
      } catch (err) {
        firstError ??= new PreferenceStoreError(
          storeErrorReason(scope, "flush", err),
          { cause: err, store: scope.store.name },
        );
      }
    }
    if (firstError !== undefined) throw firstError;
  };

  const shutdown = async (): Promise<void> => {
    if (shutDown) return;
    shutDown = true;
    subscribers.clear();

    let firstError: unknown;
    for (const scope of scopeStates) {
      if (
        scope.unsubscribedFromExternal ||
        scope.unsubscribeExternal === undefined
      ) {
        continue;
      }
      scope.unsubscribedFromExternal = true;
      try {
        scope.unsubscribeExternal();
      } catch (err) {
        firstError ??= new PreferenceStoreError(
          storeErrorReason(scope, "unwatch", err),
          { cause: err, store: scope.store.name },
        );
      }
    }

    try {
      await flush();
    } catch (err) {
      firstError ??= err;
    }

    for (const scope of scopeStates) {
      if (scope.store.shutdown === undefined) continue;
      try {
        await scope.store.shutdown();
      } catch (err) {
        firstError ??= new PreferenceStoreError(
          storeErrorReason(scope, "shutdown", err),
          { cause: err, store: scope.store.name },
        );
      }
    }

    if (firstError !== undefined) throw firstError;
  };

  return {
    values,
    diagnostics,
    set,
    update,
    reset,
    resetAll,
    isSet,
    subscribe,
    flush,
    shutdown,
    [Symbol.asyncDispose]: shutdown,
  };
}

async function prepareScopeSnapshot<S extends PreferenceSchema>(
  schema: S,
  leafPathSet: ReadonlySet<string>,
  scope: ScopeDefinition,
  snapshot: PreferenceSnapshot,
  versioning: VersioningOptions,
): Promise<PreparedScopeSnapshot> {
  const cloned = cloneSnapshot(snapshot);
  const versionResult = readSnapshotVersion(cloned, versioning.currentVersion);
  const withoutVersion = snapshotWithoutKey(cloned, VERSION_KEY);
  if (!versionResult.ok) {
    return migrationFallback(scope, leafPathSet, withoutVersion, {
      ...versionResult.diagnostic,
      version: versioning.currentVersion,
    });
  }

  let migrated: PreferenceSnapshot;
  let version = versionResult.version;
  let migration: AppliedMigration | undefined;
  try {
    const migrationResult = await runMigrations(
      withoutVersion,
      version,
      versioning,
    );
    migrated = migrationResult.snapshot;
    version = migrationResult.version;
    migration = migrationResultToAppliedMigration(migrationResult);
  } catch (err) {
    return migrationFallback(scope, leafPathSet, withoutVersion, {
      status: "migration_error",
      reason: migrationErrorReason(scope, err),
      version: versioning.currentVersion ?? version,
    });
  }

  const split = splitSnapshot(migrated, leafPathSet);
  const validated = validatePreferenceSnapshot(schema, split.known);
  return {
    explicit: cloneSnapshot(validated.explicit),
    preserved: cloneSnapshot(split.unknown),
    version,
    diagnostics: validated.diagnostics.map((diagnostic) =>
      scopeDiagnostic(scope, diagnostic),
    ),
    loadedKeys: validated.loadedKeys,
    fallbackKeys: validated.fallbackKeys,
    migration,
  };
}

async function emitDiagnostics(
  diagnostics: readonly PreferenceDiagnostic[],
  handler: DefinePreferencesBaseOptions["onDiagnostic"],
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

function normalizeScopes(
  options: DefinePreferencesOptions<PreferenceScopeStores>,
): readonly ScopeDefinition[] {
  const hasStore = "store" in options && options.store !== undefined;
  const hasScopes = "scopes" in options && options.scopes !== undefined;
  if (hasStore && hasScopes) {
    throw new PreferenceSchemaError(
      "definePreferences accepts either store or scopes, not both.",
    );
  }
  if (hasStore) {
    return [{ name: "default", store: options.store }];
  }
  if (!hasScopes) {
    throw new PreferenceSchemaError(
      "definePreferences requires a store or at least one scope.",
    );
  }

  const entries = Object.entries(options.scopes);
  if (entries.length === 0) {
    throw new PreferenceSchemaError(
      "definePreferences scopes must include at least one store.",
    );
  }

  return entries.map(([name, store]) => {
    if (name.length === 0) {
      throw new PreferenceSchemaError("Preference scope names must be non-empty.");
    }
    return { name, diagnosticScope: name, store };
  });
}

function normalizeVersioning(
  options: DefinePreferencesBaseOptions,
): VersioningOptions {
  if (options.version !== undefined) {
    assertVersionNumber(options.version, "Preference version");
  }
  if (options.version === undefined && options.migrations !== undefined) {
    throw new PreferenceSchemaError(
      "Preference migrations require a current version.",
    );
  }

  const migrations = new Map<number, PreferenceMigration>();
  for (const [rawVersion, migration] of Object.entries(
    options.migrations ?? {},
  )) {
    const version = Number(rawVersion);
    assertVersionNumber(version, `Preference migration '${rawVersion}'`);
    migrations.set(version, migration);
  }

  return { currentVersion: options.version, migrations };
}

function assertVersionNumber(version: number, label: string): void {
  if (Number.isSafeInteger(version) && version >= 1) return;
  throw new PreferenceSchemaError(`${label} must be a positive safe integer.`);
}

function assertNoReservedPreferencePath(leafPaths: readonly string[]): void {
  if (!leafPaths.includes(VERSION_KEY)) return;
  throw new PreferenceSchemaError(
    `Preference path '${VERSION_KEY}' is reserved for persisted version metadata.`,
    { path: VERSION_KEY },
  );
}

function readSnapshotVersion(
  snapshot: PreferenceSnapshot,
  currentVersion: number | undefined,
):
  | { readonly ok: true; readonly version: number | undefined }
  | { readonly ok: false; readonly diagnostic: PreferenceDiagnostic } {
  if (!hasOwn(snapshot, VERSION_KEY)) {
    return { ok: true, version: currentVersion === undefined ? undefined : 1 };
  }

  const raw = snapshot[VERSION_KEY];
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1) {
    return { ok: true, version: raw };
  }

  return {
    ok: false,
    diagnostic: {
      status: "migration_error",
      path: VERSION_KEY,
      reason: "Preference snapshot version must be a positive safe integer.",
      received: raw,
    },
  };
}

async function runMigrations(
  snapshot: PreferenceSnapshot,
  storedVersion: number | undefined,
  versioning: VersioningOptions,
): Promise<MigrationResult> {
  const currentVersion = versioning.currentVersion;
  if (currentVersion === undefined) {
    return {
      snapshot: cloneSnapshot(snapshot),
      version: storedVersion,
      appliedVersions: [],
    };
  }
  if (storedVersion !== undefined && storedVersion > currentVersion) {
    return {
      snapshot: cloneSnapshot(snapshot),
      version: storedVersion,
      appliedVersions: [],
    };
  }

  let next = cloneSnapshot(snapshot);
  const fromVersion = storedVersion ?? 1;
  const appliedVersions: number[] = [];
  for (let version = fromVersion + 1; version <= currentVersion; version += 1) {
    const migration = versioning.migrations.get(version);
    if (migration === undefined) continue;
    const migrated = await migration(cloneSnapshot(next));
    if (!isPlainRecord(migrated)) {
      throw new Error(
        `Migration ${version} must return a flat preference snapshot object.`,
      );
    }
    next = snapshotWithoutKey(cloneSnapshot(migrated), VERSION_KEY);
    appliedVersions.push(version);
  }
  return {
    snapshot: next,
    version: currentVersion,
    fromVersion,
    appliedVersions,
  };
}

function migrationResultToAppliedMigration(
  result: MigrationResult,
): AppliedMigration | undefined {
  if (result.appliedVersions.length === 0) return undefined;
  if (result.fromVersion === undefined || result.version === undefined) {
    return undefined;
  }
  return {
    fromVersion: result.fromVersion,
    toVersion: result.version,
    versions: result.appliedVersions,
  };
}

function migrationFallback(
  scope: ScopeDefinition,
  leafPathSet: ReadonlySet<string>,
  snapshot: PreferenceSnapshot,
  diagnostic: PreferenceDiagnostic,
): PreparedScopeSnapshot {
  return {
    explicit: {},
    preserved: splitSnapshot(snapshot, leafPathSet).unknown,
    version: diagnostic.version,
    diagnostics: [scopeDiagnostic(scope, diagnostic)],
    loadedKeys: [],
    fallbackKeys: [],
  };
}

function migrationErrorReason(scope: ScopeDefinition, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Preference store '${scope.store.name}' failed to migrate preferences. ${message}`;
}

function splitSnapshot(
  snapshot: PreferenceSnapshot,
  leafPathSet: ReadonlySet<string>,
): SplitSnapshot {
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const key of Object.keys(snapshot)) {
    if (key === VERSION_KEY) continue;
    const target = leafPathSet.has(key) ? known : unknown;
    setSnapshotValue(target, key, snapshot[key]);
  }
  return { known, unknown };
}

function mergeScopeExplicitSnapshots(
  scopes: readonly ScopeState[],
): PreferenceSnapshot {
  const merged: Record<string, unknown> = {};
  for (const scope of scopes) {
    copySnapshotValues(merged, scope.explicit);
  }
  return cloneSnapshot(merged);
}

function buildPersistedScopeSnapshot(
  scope: ScopeState,
  explicit: PreferenceSnapshot,
): PreferenceSnapshot {
  const persisted: Record<string, unknown> = {};
  copySnapshotValues(persisted, scope.preserved);
  copySnapshotValues(persisted, explicit);
  if (scope.version !== undefined) {
    setSnapshotValue(persisted, VERSION_KEY, scope.version);
  }
  return cloneSnapshot(persisted);
}

function snapshotWithValue(
  snapshot: PreferenceSnapshot,
  key: string,
  value: unknown,
): PreferenceSnapshot {
  const next = cloneSnapshot(snapshot) as Record<string, unknown>;
  setSnapshotValue(next, key, value);
  return next;
}

function snapshotWithoutKey(
  snapshot: PreferenceSnapshot,
  key: string,
): PreferenceSnapshot {
  const next: Record<string, unknown> = {};
  for (const existing of Object.keys(snapshot)) {
    if (existing === key) continue;
    setSnapshotValue(next, existing, snapshot[existing]);
  }
  return next;
}

function copySnapshotValues(
  target: Record<string, unknown>,
  source: PreferenceSnapshot,
): void {
  for (const key of Object.keys(source)) {
    setSnapshotValue(target, key, source[key]);
  }
}

function scopeDiagnostic(
  scope: ScopeDefinition,
  diagnostic: PreferenceDiagnostic,
): PreferenceDiagnostic {
  return {
    ...diagnostic,
    store: diagnostic.store ?? scope.store.name,
    ...(scope.diagnosticScope === undefined ? {} : { scope: scope.diagnosticScope }),
  };
}

function flattenPreferencePatch(
  schema: PreferenceSchemaNode,
  value: unknown,
  path: string,
  out: PatchEntry[],
): void {
  if (isLeaf(schema)) {
    out.push({ path, leaf: schema, value });
    return;
  }

  if (!isPlainRecord(value)) {
    throw validationError(path, "Preference update must be an object patch.");
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    const child = schema[key];
    if (child === undefined) {
      throw validationError(childPath, "Unknown preference path.");
    }
    flattenPreferencePatch(child, childValue, childPath, out);
  }
}

function notifySubscribers<S extends PreferenceSchema>(
  subscribers: Set<PreferenceChangeHandler<S>>,
  previous: PreferenceValues<S>,
  next: PreferenceValues<S>,
  changedKeys: readonly PreferencePath<S>[],
): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(previous, next, changedKeys);
    } catch {
      // One bad observer must not block the committed preference update.
    }
  }
}

function changedPreferenceKeys(
  leafPaths: readonly string[],
  previous: unknown,
  next: unknown,
): string[] {
  const changed: string[] = [];
  for (const path of leafPaths) {
    if (
      diff(
        { value: getAtPath(previous, path) },
        { value: getAtPath(next, path) },
      ).length > 0
    ) {
      changed.push(path);
    }
  }
  changed.sort();
  return changed;
}

function getAtPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function validationError(path: string, reason: string): PreferenceValidationError {
  return new PreferenceValidationError(
    path.length === 0
      ? `Invalid preference update. ${reason}`
      : `Invalid preference path '${path}'. ${reason}`,
    {
      diagnostics: [
        {
          status: "invalid",
          ...(path.length === 0 ? {} : { path }),
          reason,
        },
      ],
    },
  );
}

function scopeValidationError(scope: string): PreferenceValidationError {
  return new PreferenceValidationError(`Unknown preference scope '${scope}'.`, {
    diagnostics: [
      {
        status: "invalid",
        scope,
        reason: "Unknown preference scope.",
      },
    ],
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function hasOwn(object: PreferenceSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneSnapshot(snapshot: PreferenceSnapshot): PreferenceSnapshot {
  return cloneStoreSnapshot(snapshot);
}

function storeErrorReason(
  scope: ScopeDefinition,
  phase: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  const scopeLabel =
    scope.diagnosticScope === undefined ? "" : ` scope '${scope.diagnosticScope}'`;
  return `Preference store '${scope.store.name}'${scopeLabel} failed during ${phase}. ${message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

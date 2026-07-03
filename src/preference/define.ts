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
import { createSnapshotProxy, type SnapshotRef } from "../config/dynamic/proxy";
import { isLeaf, type Leaf } from "../config/schema/types";
import { collectLeaves, deepFreeze } from "../config/schema/walk";
import type { ConfigSchema } from "../config/types";
import { PreferenceStoreError, PreferenceValidationError } from "./errors";
import type {
  DefinePreferencesOptions,
  PreferenceChangeHandler,
  PreferenceDiagnostic,
  PreferencePath,
  PreferenceSchema,
  PreferenceSchemaNode,
  PreferenceSnapshot,
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

interface PatchEntry {
  readonly path: string;
  readonly leaf: Leaf<unknown>;
  readonly value: unknown;
}

export async function definePreferences<S extends PreferenceSchema>(
  schema: S,
  options: DefinePreferencesOptions,
): Promise<PreferencesHandle<S>> {
  assertPreferenceSchema(schema);

  const diagnostics: PreferenceDiagnostic[] = [];
  const leafEntries = collectLeaves(schema as unknown as ConfigSchema);
  const leafPaths = leafEntries.map((entry) => entry.path);
  const leafMap = new Map(
    leafEntries.map((entry) => [entry.path, entry.leaf]),
  );
  let explicit: PreferenceSnapshot | undefined;

  try {
    explicit = await options.store.load();
  } catch (err) {
    diagnostics.push({
      status: "store_error",
      store: options.store.name,
      reason: storeErrorReason(options.store.name, "load", err),
    });
  }

  const initial = validatePreferenceSnapshot(schema, explicit ?? {});
  diagnostics.push(...initial.diagnostics);

  await emitDiagnostics(diagnostics, options.onDiagnostic);

  let currentExplicit = cloneSnapshot(initial.explicit);
  const ref: SnapshotRef<PreferenceValues<S>> = {
    current: deepFreeze(initial.tree),
  };
  const subscribers = new Set<PreferenceChangeHandler<S>>();
  let unsubscribedFromExternal = false;
  let unsubscribeExternal: (() => void) | undefined;
  let shutDown = false;
  let writeQueue: Promise<void> = Promise.resolve();

  const values = createSnapshotProxy(ref as SnapshotRef<object>, {
    namespace: "forge/preference",
    mutationHint: "preference values are read-only; use set/update/reset.",
  }) as PreferenceValues<S>;

  const addDiagnostics = (nextDiagnostics: readonly PreferenceDiagnostic[]) => {
    if (nextDiagnostics.length === 0) return;
    diagnostics.push(...nextDiagnostics);
    void emitDiagnostics(nextDiagnostics, options.onDiagnostic);
  };

  const applyValidatedSnapshot = (
    nextExplicit: PreferenceSnapshot,
    nextTree: PreferenceValues<S>,
  ): void => {
    currentExplicit = cloneSnapshot(nextExplicit);
    const previous = ref.current;
    const nextValues = deepFreeze(nextTree);
    const changedKeys = changedPreferenceKeys(
      leafPaths,
      previous,
      nextValues,
    ) as PreferencePath<S>[];
    if (changedKeys.length === 0) return;

    ref.current = nextValues;
    notifySubscribers(subscribers, previous, ref.current, changedKeys);
  };

  const enqueueStateChange = (
    work: () => void | Promise<void>,
  ): Promise<void> => {
    const run = writeQueue.then(work);
    writeQueue = run.catch(() => {});
    return run;
  };

  const applyExternalSnapshot = (snapshot: PreferenceSnapshot): void => {
    void enqueueStateChange(() => {
      if (shutDown) return;
      const result = validatePreferenceSnapshot(schema, snapshot);
      addDiagnostics(result.diagnostics);
      applyValidatedSnapshot(result.explicit, result.tree);
    });
  };

  if (options.store.watch !== undefined) {
    try {
      unsubscribeExternal = options.store.watch(applyExternalSnapshot);
    } catch (err) {
      addDiagnostics([
        {
          status: "store_error",
          store: options.store.name,
          reason: storeErrorReason(options.store.name, "watch", err),
        },
      ]);
    }
  }

  const requireLeaf = (path: string): Leaf<unknown> => {
    const leaf = leafMap.get(path);
    if (leaf !== undefined) return leaf;
    throw validationError(path, "Unknown preference path.");
  };

  const commitExplicit = async (
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
      await options.store.save(result.explicit);
    } catch (err) {
      throw new PreferenceStoreError(
        storeErrorReason(options.store.name, "save", err),
        { cause: err, store: options.store.name },
      );
    }

    applyValidatedSnapshot(result.explicit, result.tree);
  };

  const assertOpen = (): void => {
    if (!shutDown) return;
    throw new PreferenceStoreError(
      `Preference store '${options.store.name}' has been shut down.`,
      { store: options.store.name },
    );
  };

  const set = async <P extends PreferencePath<S>>(
    path: P,
    value: PreferenceWritableValue<S, P>,
  ): Promise<void> => {
    assertOpen();
    const leaf = requireLeaf(path);
    const validated = validatePreferenceWriteValue(path, leaf, value);
    if (!validated.ok) {
      throw new PreferenceValidationError(
        `Invalid preference value for '${path}'.`,
        { diagnostics: [validated.diagnostic] },
      );
    }

    await enqueueStateChange(async () => {
      const nextExplicit: Record<string, unknown> = {
        ...cloneSnapshot(currentExplicit),
      };
      nextExplicit[path] = validated.snapshotValue;
      await commitExplicit(nextExplicit);
    });
  };

  const update = async (
    updater: (
      values: PreferenceValues<S>,
    ) => PreferenceUpdate<S> | void | Promise<PreferenceUpdate<S> | void>,
  ): Promise<void> => {
    assertOpen();
    await enqueueStateChange(async () => {
      const patch = await updater(ref.current);
      if (patch === undefined) return;

      const entries: PatchEntry[] = [];
      flattenPreferencePatch(schema, patch, "", entries);
      if (entries.length === 0) return;

      const validated = entries.map((entry) => {
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
        return { path: entry.path, snapshotValue: result.snapshotValue };
      });

      const nextExplicit: Record<string, unknown> = {
        ...cloneSnapshot(currentExplicit),
      };
      for (const entry of validated) {
        nextExplicit[entry.path] = entry.snapshotValue;
      }
      await commitExplicit(nextExplicit);
    });
  };

  const reset = async <P extends PreferencePath<S>>(path: P): Promise<void> => {
    assertOpen();
    requireLeaf(path);
    await enqueueStateChange(async () => {
      if (!hasOwn(currentExplicit, path)) return;

      const nextExplicit: Record<string, unknown> = {
        ...cloneSnapshot(currentExplicit),
      };
      delete nextExplicit[path];
      await commitExplicit(nextExplicit);
    });
  };

  const resetAll = async (): Promise<void> => {
    assertOpen();
    await enqueueStateChange(async () => {
      await commitExplicit({});
    });
  };

  const isSet = <P extends PreferencePath<S>>(path: P): boolean => {
    requireLeaf(path);
    return hasOwn(currentExplicit, path);
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
    if (options.store.flush === undefined) return;
    try {
      await options.store.flush();
    } catch (err) {
      throw new PreferenceStoreError(
        storeErrorReason(options.store.name, "flush", err),
        { cause: err, store: options.store.name },
      );
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shutDown) return;
    shutDown = true;
    subscribers.clear();

    let firstError: unknown;
    if (!unsubscribedFromExternal && unsubscribeExternal !== undefined) {
      unsubscribedFromExternal = true;
      try {
        unsubscribeExternal();
      } catch (err) {
        firstError = new PreferenceStoreError(
          storeErrorReason(options.store.name, "unwatch", err),
          { cause: err, store: options.store.name },
        );
      }
    }

    try {
      await flush();
    } catch (err) {
      firstError ??= err;
    }

    if (options.store.shutdown !== undefined) {
      try {
        await options.store.shutdown();
      } catch (err) {
        firstError ??= new PreferenceStoreError(
          storeErrorReason(options.store.name, "shutdown", err),
          { cause: err, store: options.store.name },
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

function hasOwn(object: PreferenceSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneSnapshot(snapshot: PreferenceSnapshot): PreferenceSnapshot {
  return structuredClone(snapshot) as PreferenceSnapshot;
}

function storeErrorReason(store: string, phase: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Preference store '${store}' failed during ${phase}. ${message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
